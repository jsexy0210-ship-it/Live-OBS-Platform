import type { PlatformMaintenance, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { cleanText } from "../text/clean";

// 점검 모드(마스터 MA-083 · 점검 중 화면 AU-010). 규칙:
// - 보기는 마스터 관리자 모든 역할(platform.read), 바꾸기는 최고관리자만(system.manage, ARCHITECTURE 3.2 「시스템 설정·점검 모드」). 바꿀 때마다 로그 추적에 전후.
// - 켜져 있고(enabled) 시작 시각이 지났으면(없으면 바로) 점검 중. 종료 예정 시각은 안내용이고 지나도 저절로 끄지 않는다.
// - 점검 중이면 루트 proxy.ts가 파트너스·구매자·가입 API를 503 maintenance로, /seller·/shop 화면을 /maintenance(AU-010)로 돌린다.
//   마스터 관리자, 오버레이(방송 화면이 꺼지지 않게), 결제사 결과 알림, 정기 작업, 상태 확인, 공지·공개 정보는 그대로 연다(MAINTENANCE_BLOCKED).
// - 상태 읽기는 서버마다 5초 기억한다(요청마다 DB를 읽지 않음). 바꾼 서버는 바로 지운다. DB를 못 읽으면 막지 않는다(점검 표시보다 서비스 유지).

type Db = PrismaClient | Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };

export const MESSAGE_MAX = 500;
export const CACHE_MS = 5_000;

export type MaintenanceRejection = "invalid_message" | "invalid_reason" | "invalid_time" | "version_conflict";
// 마스터 관리자 화면 문구(합니다체)
export const MAINTENANCE_MESSAGES: Record<MaintenanceRejection, string> = {
  invalid_message: `안내 문구를 ${MESSAGE_MAX}자 안에서 입력해 주십시오`,
  invalid_reason: "점검 사유를 100자 안에서 입력해 주십시오",
  invalid_time: "종료 예정 시각은 시작 시각보다 뒤여야 합니다",
  version_conflict: "다른 곳에서 먼저 고쳤습니다. 새로고침한 뒤 다시 시도해 주십시오",
};
// 안내 문구를 비워 둔 채 점검 중일 때의 기본 문구: 파트너스 관리자 API는 합니다체, 구매자·가입 신청 API는 해요체
export const MAINTENANCE_NOTICE_FORMAL = "지금은 서비스 점검 중입니다. 잠시 뒤에 다시 이용해 주십시오";
export const MAINTENANCE_NOTICE = "지금은 서비스 점검 중이에요. 잠시 뒤에 다시 이용해 주세요";
export const maintenanceNotice = (pathname: string) => (/^\/api\/(seller|automation)(\/|$)/.test(pathname) ? MAINTENANCE_NOTICE_FORMAL : MAINTENANCE_NOTICE);

type Row = Pick<PlatformMaintenance, "enabled" | "message" | "reason" | "startsAt" | "endsAt" | "version" | "updatedByAdminId" | "updatedAt">;
const OFF: Row = { enabled: false, message: "", reason: "", startsAt: null, endsAt: null, version: 0, updatedByAdminId: null, updatedAt: new Date(0) };

async function read(db: Db): Promise<Row> {
  return (await db.platformMaintenance.findUnique({ where: { id: 1 } })) ?? OFF;
}
export const isActive = (r: Pick<Row, "enabled" | "startsAt">, now = new Date()) => r.enabled && (!r.startsAt || r.startsAt <= now);

// 공개 상태(AU-010·띠 안내). 예정된 점검이면 scheduled에 시각을 준다.
export function publicView(r: Row, now = new Date()) {
  const active = isActive(r, now);
  return {
    active,
    message: r.enabled ? r.message : "",
    ...(r.enabled && r.reason ? { reason: r.reason } : {}),
    startsAt: r.enabled ? r.startsAt : null,
    endsAt: r.enabled ? r.endsAt : null,
    scheduled: r.enabled && !active,
  };
}

let cache: { at: number; row: Row } | null = null;
export function clearMaintenanceCache() {
  cache = null;
}
// proxy.ts가 쓰는 상태(5초 기억). DB 오류면 null(막지 않음).
export async function cachedMaintenance(db: PrismaClient, nowMs = Date.now()): Promise<Row | null> {
  if (cache && nowMs - cache.at < CACHE_MS) return cache.row;
  try {
    const row = await read(db);
    cache = { at: nowMs, row };
    return row;
  } catch (e) {
    console.error("[maintenance] 상태를 읽지 못했습니다", e);
    return null;
  }
}

// 점검 중에 막는 경로(자동 연결 「다른 카드로 결제」 결제창 결과 return은 결제사가 부르는 복귀 경로라 열어 둔다). 마스터 관리자·오버레이·결제사 알림·정기 작업·상태 확인·공지·요금 정보·브랜딩은 열어 둔다.
const BLOCKED_API = [/^\/api\/seller(\/|$)/, /^\/api\/seller-signup(\/|$)/, /^\/api\/shop(\/|$)/, /^\/api\/automation\/(?!purchase\/one-time\/return$)(purchase|reconnect)(\/|$)/];
const BLOCKED_PAGE = [/^\/seller(\/|$)/, /^\/shop(\/|$)/];
export function maintenanceTarget(pathname: string): "api" | "page" | null {
  if (BLOCKED_API.some((r) => r.test(pathname))) return "api";
  if (BLOCKED_PAGE.some((r) => r.test(pathname))) return "page";
  return null;
}

const adminView = async (db: Db, r: Row) => {
  const by = r.updatedByAdminId ? await db.platformAdmin.findUnique({ where: { id: r.updatedByAdminId }, select: { name: true } }) : null;
  const [logs, liveBroadcasts, waitingOrders] = await Promise.all([
    db.auditLog.findMany({ where: { action: "platform.maintenance.update", targetType: "PlatformMaintenance", targetId: "1" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30, select: { id: true, createdAt: true, before: true, after: true } }),
    db.broadcastSession.count({ where: { status: "LIVE" } }),
    db.queueItem.count({ where: { status: "WAITING" } }),
  ]);
  const history = logs.map((log) => {
    const before = log.before && typeof log.before === "object" && !Array.isArray(log.before) ? log.before as Record<string, Prisma.JsonValue> : {};
    const after = log.after && typeof log.after === "object" && !Array.isArray(log.after) ? log.after as Record<string, Prisma.JsonValue> : {};
    const scheduled = typeof before.startsAt === "string" && new Date(before.startsAt) > log.createdAt;
    const action = after.enabled === false ? before.enabled === true ? scheduled ? "예약 취소" : "점검 종료" : "설정 변경" : before.enabled === true ? "설정 변경" : typeof after.startsAt === "string" && new Date(after.startsAt) > log.createdAt ? "예약 저장" : "즉시 켬";
    return { id: log.id, at: log.createdAt, action, reason: typeof after.reason === "string" && after.reason ? after.reason : typeof before.reason === "string" ? before.reason : "", message: typeof after.message === "string" ? after.message : "" };
  });
  return { ...publicView(r), enabled: r.enabled, message: r.message, reason: r.reason, startsAt: r.startsAt, endsAt: r.endsAt, version: r.version, updatedAt: r.updatedByAdminId ? r.updatedAt : null, updatedByAdminName: by?.name ?? null, history, liveBroadcasts, waitingOrders };
};

export async function getMaintenance(db: PrismaClient, admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  return adminView(db, await read(db));
}

function parseTime(v: unknown): Date | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// 바꾸기. 본문 { enabled, message, startsAt?, endsAt?, expectedVersion }. 켜려면 안내 문구가 있어야 한다.
export async function updateMaintenance(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: AuditMeta = {}) {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const enabled = b.enabled === true;
  const reason = b.reason === undefined ? undefined : cleanText(b.reason, 100);
  if (reason === null || (enabled && b.reason !== undefined && !reason)) return { ok: false as const, reason: "invalid_reason" as const };
  const message = b.message === undefined || b.message === "" ? "" : cleanText(b.message, MESSAGE_MAX, "multiline");
  if (message === null || (enabled && !message)) return { ok: false as const, reason: "invalid_message" as const };
  const startsAt = parseTime(b.startsAt);
  const endsAt = parseTime(b.endsAt);
  if (startsAt === undefined || endsAt === undefined) return { ok: false as const, reason: "invalid_time" as const };
  if (endsAt && endsAt <= (startsAt ?? new Date())) return { ok: false as const, reason: "invalid_time" as const };
  const r = await db.$transaction(async (tx) => {
    // 줄이 없을 때만 만든다(마이그레이션이 넣어 두지만 지워졌을 때). 동시 변경은 아래 FOR UPDATE가 막는다.
    if (!(await tx.platformMaintenance.findUnique({ where: { id: 1 }, select: { id: true } }))) {
      await tx.$executeRaw`INSERT INTO "PlatformMaintenance" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING`;
    }
    const [cur] = await tx.$queryRaw<Row[]>`SELECT "enabled", "message", "reason", "startsAt", "endsAt", "version", "updatedByAdminId", "updatedAt" FROM "PlatformMaintenance" WHERE "id" = 1 FOR UPDATE`;
    if (b.expectedVersion !== cur.version) return { ok: false as const, reason: "version_conflict" as const, currentVersion: cur.version };
    // version 조건을 함께 걸어, 잠금과 상관없이 같은 version으로 두 번 바뀌지 않게 한다
    const done = await tx.platformMaintenance.updateMany({ where: { id: 1, version: cur.version }, data: { enabled, message, reason, startsAt, endsAt, updatedByAdminId: admin.admin.id, version: { increment: 1 } } });
    if (done.count !== 1) return { ok: false as const, reason: "version_conflict" as const, currentVersion: cur.version + 1 };
    const row = await tx.platformMaintenance.findUniqueOrThrow({ where: { id: 1 } });
    const pick = (x: Row) => ({ enabled: x.enabled, message: x.message, reason: x.reason, startsAt: x.startsAt, endsAt: x.endsAt });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "platform.maintenance.update",
      targetType: "PlatformMaintenance",
      targetId: "1",
      before: pick(cur),
      after: pick(row),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, row };
  });
  if (!r.ok) return r;
  clearMaintenanceCache();
  return { ok: true as const, maintenance: await adminView(db, r.row) };
}

export async function getPublicMaintenance(db: PrismaClient) {
  return publicView(await read(db));
}
