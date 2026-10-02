import { Prisma, type PrismaClient } from "@prisma/client";
import { IP_LOCK, LOGIN_LOCK, type Realm } from "./policy";

// 로그인 실패 횟수는 DB에서 원자적으로 올린다(읽고 앱에서 +1 하면 동시 요청으로 잠금을 피할 수 있다).

type AccountTable = "PlatformAdmin" | "SellerUser" | "BuyerMember";
const ts = (d: Date) => d.toISOString();

// 계정 실패 1회. 5회째면 같은 문장 안에서 10분 잠그고 횟수를 0으로 되돌린다. 실패 뒤 잠겨 있으면 true.
export async function recordAccountFailure(db: PrismaClient, table: AccountTable, id: string, now: Date): Promise<boolean> {
  const lockUntil = new Date(now.getTime() + LOGIN_LOCK.lockMs);
  const rows = await db.$queryRaw<{ locked: boolean }[]>`
    UPDATE ${Prisma.raw(`"${table}"`)} SET
      "failedLoginCount" = CASE WHEN "failedLoginCount" + 1 >= ${LOGIN_LOCK.maxFailures} THEN 0 ELSE "failedLoginCount" + 1 END,
      "lockedUntil" = CASE WHEN "failedLoginCount" + 1 >= ${LOGIN_LOCK.maxFailures} THEN ${ts(lockUntil)}::timestamptz ELSE "lockedUntil" END
    WHERE "id" = ${id}::uuid
    RETURNING ("lockedUntil" IS NOT NULL AND "lockedUntil" > ${ts(now)}::timestamptz) AS locked`;
  return rows[0]?.locked ?? false;
}

// 성공 처리. 그사이 다른 요청이 잠갔으면 false(로그인 거부).
export async function recordAccountSuccess(db: PrismaClient, table: AccountTable, id: string, now: Date): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${table}"`)} SET "failedLoginCount" = 0, "lockedUntil" = NULL, "lastLoginAt" = ${ts(now)}::timestamptz
    WHERE "id" = ${id}::uuid AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${ts(now)}::timestamptz)`;
  return n === 1;
}

const ipKey = (realm: Realm, ip: string) => `${realm}:ip:${ip}`;

export async function isIpBlocked(db: PrismaClient, realm: Realm, ip: string | null | undefined, now: Date): Promise<boolean> {
  if (!ip) return false;
  const row = await db.loginThrottle.findUnique({ where: { key: ipKey(realm, ip) }, select: { lockedUntil: true } });
  return !!row?.lockedUntil && row.lockedUntil > now;
}

// IP 실패 1회. 10분 창 안에서 20회에 이르면 10분 막는다. IP를 알 수 없으면(신뢰 프록시 미설정) 세지 않는다.
export async function recordIpFailure(db: PrismaClient, realm: Realm, ip: string | null | undefined, now: Date): Promise<boolean> {
  if (!ip) return false;
  const windowFloor = new Date(now.getTime() - IP_LOCK.windowMs);
  const lockUntil = new Date(now.getTime() + IP_LOCK.lockMs);
  const fresh = Prisma.sql`"LoginThrottle"."windowStart" <= ${ts(windowFloor)}::timestamptz`;
  const rows = await db.$queryRaw<{ locked: boolean }[]>`
    INSERT INTO "LoginThrottle" ("key", "failures", "windowStart", "updatedAt")
    VALUES (${ipKey(realm, ip)}, 1, ${ts(now)}::timestamptz, ${ts(now)}::timestamptz)
    ON CONFLICT ("key") DO UPDATE SET
      "failures" = CASE WHEN ${fresh} THEN 1 ELSE "LoginThrottle"."failures" + 1 END,
      "windowStart" = CASE WHEN ${fresh} THEN ${ts(now)}::timestamptz ELSE "LoginThrottle"."windowStart" END,
      "lockedUntil" = CASE WHEN (CASE WHEN ${fresh} THEN 1 ELSE "LoginThrottle"."failures" + 1 END) >= ${IP_LOCK.maxFailures}
        THEN ${ts(lockUntil)}::timestamptz ELSE "LoginThrottle"."lockedUntil" END,
      "updatedAt" = ${ts(now)}::timestamptz
    RETURNING ("lockedUntil" IS NOT NULL AND "lockedUntil" > ${ts(now)}::timestamptz) AS locked`;
  return rows[0]?.locked ?? false;
}
