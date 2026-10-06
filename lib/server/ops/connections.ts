import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";

// 외부 연결 만료·상태(MA-120, 대표님 지시 2026-10-06 「연결된 공공 API 만료일자도 지속 확인」).
// 연결 목록은 여기서 정한다. 새 외부 연동을 붙이면 목록에 한 줄 넣고, 그 연동의 호출부에서 recordConnectionResult를 부른다.
// 키 값은 응답·로그·기록 어디에도 넣지 않는다(상태 코드만).
export const CONNECTIONS = [
  { key: "nts_business_status", name: "국세청 사업자 상태조회(공공데이터포털)", purpose: "파트너스 가입 사업자 점검" },
  { key: "ftc_mail_order", name: "공정위 통신판매사업자 등록상세(공공데이터포털)", purpose: "파트너스 가입 통신판매업 점검" },
  { key: "payment_gateway", name: "결제대행사", purpose: "구매자 결제·구독료 결제" },
  { key: "mail", name: "메일 서비스", purpose: "거래·안내 메일 발송" },
  { key: "identity_verification", name: "본인인증 대행사", purpose: "구매자·파트너스 본인확인" },
  { key: "gemini", name: "도우미·자동 연결(Gemini)", purpose: "파트너스 도우미 답변·자동 연결 판단" },
] as const;
export type ConnectionKey = (typeof CONNECTIONS)[number]["key"];
const isKey = (k: unknown): k is ConnectionKey => typeof k === "string" && CONNECTIONS.some((c) => c.key === k);

type Db = PrismaClient | Prisma.TransactionClient;

// 각 연동 호출부가 부른다. 정상 응답이면 "ok", 인증 실패(키 만료·권한 없음, 보통 HTTP 401·403)면 "auth_error"와 상태 코드.
// 기록 실패가 연동 호출을 깨지 않도록 오류는 삼킨다(로그만).
export async function recordConnectionResult(db: Db, key: ConnectionKey, result: "ok" | "auth_error", code?: string, now = new Date()): Promise<void> {
  try {
    if (result === "ok") {
      await db.externalConnection.upsert({ where: { key }, create: { key, lastOkAt: now }, update: { lastOkAt: now } });
    } else {
      const c = (code ?? "auth_error").slice(0, 40);
      await db.externalConnection.upsert({ where: { key }, create: { key, lastAuthErrorAt: now, lastAuthErrorCode: c }, update: { lastAuthErrorAt: now, lastAuthErrorCode: c } });
    }
  } catch (e) {
    console.error(`[connections] ${key} 기록 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
export const EXPIRY_SOON_DAYS = 30;
export const EXPIRY_URGENT_DAYS = 7;

// 만료일(YYYY-MM-DD, KST)은 그날 끝(다음 날 0시 KST)까지 유효로 저장한다.
const expiresAtOf = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) + DAY_MS - KST_MS);
const ymdOf = (d: Date) => new Date(d.getTime() + KST_MS - 1).toISOString().slice(0, 10);
const validYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

export type ConnectionStatus = "ok" | "expiring" | "auth_error" | "not_connected";

// 상태: 인증 오류(마지막 정상 호출 뒤에 난 것) > 만료 임박(30일 이내, 지난 것 포함) > 연결 전(정상 호출 기록 없음) > 정상
export function connectionStatus(c: { expiresAt: Date | null; lastOkAt: Date | null; lastAuthErrorAt: Date | null }, now: Date): ConnectionStatus {
  if (c.lastAuthErrorAt && (!c.lastOkAt || c.lastAuthErrorAt > c.lastOkAt)) return "auth_error";
  if (c.expiresAt && daysLeft(c.expiresAt, now) <= EXPIRY_SOON_DAYS) return "expiring";
  if (!c.lastOkAt) return "not_connected";
  return "ok";
}
// 남은 일수: 만료일 당일 0, 하루 지나면 -1
const daysLeft = (expiresAt: Date, now: Date) => Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS);

export async function listConnections(db: Db, admin: AdminSessionContext, opts: { now?: Date } = {}) {
  if (!adminCan(admin.admin.role, "infra.manage")) throw forbidden();
  return readConnections(db, opts.now ?? new Date());
}

// 권한 확인 없는 조회(정기 실행 알림 판단용). 화면·API는 listConnections로만 부른다.
export async function readConnections(db: Db, now: Date) {
  const rows = new Map((await db.externalConnection.findMany()).map((r) => [r.key, r]));
  const connections = CONNECTIONS.map((c) => {
    const r = rows.get(c.key);
    const expiresAt = r?.expiresAt ?? null;
    return {
      key: c.key,
      name: c.name,
      purpose: c.purpose,
      expiresOn: expiresAt ? ymdOf(expiresAt) : null,
      daysLeft: expiresAt ? daysLeft(expiresAt, now) : null,
      lastOkAt: r?.lastOkAt?.toISOString() ?? null,
      lastAuthErrorAt: r?.lastAuthErrorAt?.toISOString() ?? null,
      lastAuthErrorCode: r?.lastAuthErrorCode ?? null,
      status: connectionStatus({ expiresAt, lastOkAt: r?.lastOkAt ?? null, lastAuthErrorAt: r?.lastAuthErrorAt ?? null }, now),
      version: r?.version ?? 0,
    };
  });
  return { checkedAt: now.toISOString(), connections };
}

// 홈 요약용 경고 개수: 만료 30일 이내(8~30일, 아직 안 급함) · 7일 이내(지난 것 포함) · 인증 오류
export function connectionWarnings(list: Awaited<ReturnType<typeof listConnections>>["connections"]) {
  let expiring30 = 0;
  let expiring7 = 0;
  let authError = 0;
  for (const c of list) {
    if (c.status === "auth_error") authError++;
    if (c.daysLeft !== null && c.daysLeft <= EXPIRY_URGENT_DAYS) expiring7++;
    else if (c.daysLeft !== null && c.daysLeft <= EXPIRY_SOON_DAYS) expiring30++;
  }
  return { expiring30, expiring7, authError };
}

// 만료일 입력(최고관리자만, 로그 추적 admin.infra.connection_expiry_update). expiresOn null이면 지움. expectedVersion이 다르면 거절.
export async function updateConnectionExpiry(
  db: PrismaClient,
  admin: AdminSessionContext,
  key: string,
  input: { expiresOn?: unknown; expectedVersion?: unknown },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  if (!adminCan(admin.admin.role, "infra.manage")) throw forbidden();
  if (!isKey(key)) return { ok: false as const, reason: "not_found" as const };
  if (typeof input.expectedVersion !== "number" || !(input.expiresOn === null || validYmd(input.expiresOn))) return { ok: false as const, reason: "invalid_input" as const };
  const expiresAt = input.expiresOn === null ? null : expiresAtOf(input.expiresOn as string);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "ExternalConnection" ("key") VALUES (${key}) ON CONFLICT ("key") DO NOTHING`;
    await tx.$queryRaw`SELECT "key" FROM "ExternalConnection" WHERE "key" = ${key} FOR UPDATE`;
    const cur = await tx.externalConnection.findUniqueOrThrow({ where: { key } });
    if (cur.version !== input.expectedVersion) return { ok: false as const, reason: "version_conflict" as const };
    const row = await tx.externalConnection.update({ where: { key }, data: { expiresAt, version: { increment: 1 }, updatedByAdminId: admin.admin.id } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "admin.infra.connection_expiry_update",
      targetType: "ExternalConnection",
      targetId: key,
      before: { expiresOn: cur.expiresAt ? ymdOf(cur.expiresAt) : null },
      after: { expiresOn: row.expiresAt ? ymdOf(row.expiresAt) : null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, expiresOn: row.expiresAt ? ymdOf(row.expiresAt) : null, version: row.version };
  });
}
