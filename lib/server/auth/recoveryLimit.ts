import type { Prisma } from "@prisma/client";

// 아이디 찾기·비밀번호 찾기(대표자·직원) 본인확인 시작 한도(PRODUCT_SCOPE 「본인확인 횟수 제한」, 2026-10-04 MASTER 보완).
// 본인확인 시작 전에 같은 휴대폰 번호 하루 10회, 같은 접속 IP 하루 30회(KST 자정 초기화, 아이디 찾기·비밀번호 찾기 합산)를 센다.
// 쇼핑몰 주소를 입력한 비밀번호 찾기는 쇼핑몰당 하루 10회(auth/passwordReset.ts)도 함께 적용한다.
export const RECOVERY_DAILY_LIMIT_PER_PHONE = 10;
export const RECOVERY_DAILY_LIMIT_PER_IP = 30;

// 트랜잭션 안에서 부른다. 번호·IP별로 줄을 세운 뒤(같은 순서로 잠가 교착 없음) 오늘 시작 건수를 DB 시계로 센다.
// IP를 모르면(신뢰 프록시 미설정) 하나의 묶음으로 센다. 넘으면 true.
export async function recoveryLimitReached(tx: Prisma.TransactionClient, phone: string, ip: string | null): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recovery_phone:${phone}`}))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recovery_ip:${ip ?? "unknown"}`}))`;
  const [{ byPhone, byIp }] = await tx.$queryRaw<{ byPhone: bigint; byIp: bigint }[]>`
    SELECT count(*) FILTER (WHERE "requestedPhone" = ${phone})::bigint AS "byPhone",
           count(*) FILTER (WHERE "requestIp" IS NOT DISTINCT FROM ${ip})::bigint AS "byIp"
    FROM "IdentityVerification"
    WHERE "purpose" IN ('PASSWORD_RESET', 'ACCOUNT_RECOVERY')
      AND "createdAt" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
  return Number(byPhone) >= RECOVERY_DAILY_LIMIT_PER_PHONE || Number(byIp) >= RECOVERY_DAILY_LIMIT_PER_IP;
}
