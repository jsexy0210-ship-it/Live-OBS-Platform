import type { PlatformMaintenanceWindow, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { decodeCursor, encodeCursor } from "../orders/read";
import { cleanText } from "../text/clean";
import { closeWindow, lockMirror, OPEN_MAX, syncMirror } from "./windowsCore";
import { clearMaintenanceCache, MESSAGE_MAX, type AuditMeta } from "./service";

// 점검 예약·이력(MA-083). 보기는 마스터 관리자 전 역할(platform.read), 예약·즉시 켜기·예약 취소·점검 종료는 최고관리자만(system.manage). 모두 로그 추적에 남긴다.
// 확정 결정: 점검이 시작돼도 방송을 자동으로 끝내거나 대기 주문을 옮기지 않는다(종료 예정 시각은 안내용). 시작 전 10분 경고·종료 알림 같은 자동 처리와 점검 공지 연결은 후속 작업이다.
export const REASON_MAX = 200;
export const HISTORY_DEFAULT = 20;
export const HISTORY_MAX = 100;

export type WindowRejection = "invalid_message" | "reason_required" | "invalid_time" | "already_active" | "too_many" | "bad_request";
export const WINDOW_MESSAGES: Record<WindowRejection, string> = {
  invalid_message: `안내 문구를 ${MESSAGE_MAX}자 안에서 입력해 주십시오`,
  reason_required: `사유를 ${REASON_MAX}자 안에서 입력해 주십시오`,
  invalid_time: "시작 시각은 지금보다 뒤, 종료 예정 시각은 시작 시각보다 뒤여야 합니다",
  already_active: "이미 점검 중입니다. 먼저 점검을 종료해 주십시오",
  too_many: `예약은 ${OPEN_MAX}건까지 둘 수 있습니다`,
  bad_request: "조회 조건을 다시 확인해 주십시오",
};

const requireRead = (admin: AdminSessionContext) => {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
};
const requireManage = (admin: AdminSessionContext) => {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
};

// 상태: 저장은 예약·종료·취소 셋이고, 예약이어도 시작 시각이 지났으면 점검 중(ACTIVE)으로 보여 준다.
type Phase = "SCHEDULED" | "ACTIVE" | "ENDED" | "CANCELED";
const phaseOf = (w: Pick<PlatformMaintenanceWindow, "status" | "startsAt">, now: Date): Phase => (w.status === "SCHEDULED" ? (w.startsAt <= now ? "ACTIVE" : "SCHEDULED") : w.status);

async function view(db: PrismaClient, rows: PlatformMaintenanceWindow[], now: Date) {
  const ids = [...new Set(rows.flatMap((r) => [r.createdByAdminId, r.endedByAdminId]).filter((x): x is string => !!x))];
  const admins = ids.length ? await db.platformAdmin.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = new Map(admins.map((a) => [a.id, a.name]));
  return rows.map((w) => ({
    id: w.id,
    phase: phaseOf(w, now),
    kind: w.immediate ? ("IMMEDIATE" as const) : ("SCHEDULED" as const),
    startsAt: w.startsAt,
    plannedEndsAt: w.endsAt,
    endedAt: w.endedAt,
    message: w.message,
    reason: w.reason,
    createdByName: w.createdByAdminId ? (names.get(w.createdByAdminId) ?? null) : null,
    endedByName: w.endedByAdminId ? (names.get(w.endedByAdminId) ?? null) : null,
    // 점검 시간과 겹친 방송 수(종료 때 센 값, 진행 중·예약은 null)
    affectedBroadcasts: w.affectedBroadcasts,
  }));
}

function parseTime(v: unknown): Date | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// → { upcoming: 예약·진행 중(시작 이른 순), live: { broadcasts, waitingOrders }(지금 방송 수·대기 주문 수, 즉시 켜기 전 확인용), history: 지난 점검(종료·취소, 최근 순), nextCursor }
// history 쿼리: cursor, limit(기본 20, 최대 100). 공지 읽음 수는 점검 공지 연결(후속)과 함께 붙인다.
export async function listWindows(db: PrismaClient, admin: AdminSessionContext, query: { cursor?: string | null; limit?: string | null } = {}, now = new Date()) {
  requireRead(admin);
  const limit = query.limit == null || query.limit === "" ? HISTORY_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, HISTORY_MAX);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  const [open, closed, broadcasts, waitingOrders] = await Promise.all([
    db.platformMaintenanceWindow.findMany({ where: { status: "SCHEDULED" }, orderBy: [{ startsAt: "asc" }, { id: "asc" }] }),
    db.platformMaintenanceWindow.findMany({
      where: { status: { in: ["ENDED", "CANCELED"] }, ...(cursor ? { OR: [{ endedAt: { lt: cursor.createdAt } }, { endedAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ endedAt: "desc" }, { id: "desc" }],
      take: take + 1,
    }),
    db.broadcastSession.count({ where: { status: "LIVE" } }),
    db.queueItem.count({ where: { status: "WAITING" } }),
  ]);
  const page = closed.slice(0, take);
  const last = page[page.length - 1];
  return {
    ok: true as const,
    upcoming: await view(db, open, now),
    live: { broadcasts, waitingOrders },
    history: await view(db, page, now),
    nextCursor: closed.length > take && last?.endedAt ? encodeCursor(last.endedAt, last.id) : null,
  };
}

// 예약·즉시 켜기. 본문 { message(안내 문구, 필수 500자), reason(사유, 필수 200자), startsAt?(ISO, 지금보다 뒤, 없으면 즉시), endsAt?(ISO, 종료 예정·안내용) }.
// 즉시 켜기는 이미 점검 중이면 already_active. 예약은 열려 있는 것이 20건을 넘으면 too_many.
export async function createWindow(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: AuditMeta = {}, now = new Date()) {
  requireManage(admin);
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const message = cleanText(b.message, MESSAGE_MAX, "multiline");
  if (!message) return { ok: false as const, reason: "invalid_message" as const };
  const reason = cleanText(b.reason, REASON_MAX, "memo");
  if (!reason) return { ok: false as const, reason: "reason_required" as const };
  const start = parseTime(b.startsAt);
  const endsAt = parseTime(b.endsAt);
  if (start === undefined || endsAt === undefined) return { ok: false as const, reason: "invalid_time" as const };
  const immediate = start === null;
  const startsAt = start ?? now;
  if ((!immediate && startsAt <= now) || (endsAt && endsAt <= startsAt)) return { ok: false as const, reason: "invalid_time" as const };
  const r = await db.$transaction(async (tx) => {
    await lockMirror(tx);
    const open = await tx.platformMaintenanceWindow.findMany({ where: { status: "SCHEDULED" }, select: { startsAt: true } });
    if (immediate && open.some((w) => w.startsAt <= now)) return { ok: false as const, reason: "already_active" as const };
    if (open.length >= OPEN_MAX) return { ok: false as const, reason: "too_many" as const };
    const w = await tx.platformMaintenanceWindow.create({ data: { message, reason, startsAt, endsAt, immediate, createdByAdminId: admin.admin.id } });
    await syncMirror(tx, admin.admin.id);
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "platform.maintenance.window.create",
      targetType: "PlatformMaintenanceWindow",
      targetId: w.id,
      reason,
      after: { immediate, startsAt, endsAt, messageLength: message.length },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, w };
  });
  if (!r.ok) return r;
  clearMaintenanceCache();
  return { ok: true as const, window: (await view(db, [r.w], now))[0] };
}

type CloseResult = { ok: true; window: Awaited<ReturnType<typeof view>>[number] } | { ok: false; reason: "not_found" | "not_open" };
// 예약 취소(시작 전만) · 점검 종료(진행 중만). 시작이 지난 예약은 취소가 아니라 점검 종료로 닫는다.
async function close(db: PrismaClient, admin: AdminSessionContext, id: string, mode: "cancel" | "end", meta: AuditMeta, now: Date): Promise<CloseResult> {
  requireManage(admin);
  const r = await db.$transaction(async (tx) => {
    await lockMirror(tx);
    const w = await tx.platformMaintenanceWindow.findUnique({ where: { id } });
    if (!w) return { ok: false as const, reason: "not_found" as const };
    const started = w.startsAt <= now;
    if (w.status !== "SCHEDULED" || started !== (mode === "end")) return { ok: false as const, reason: "not_open" as const };
    if (!(await closeWindow(tx, w, mode === "end" ? "ENDED" : "CANCELED", admin.admin.id, now))) return { ok: false as const, reason: "not_open" as const };
    await syncMirror(tx, admin.admin.id);
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: mode === "end" ? "platform.maintenance.window.end" : "platform.maintenance.window.cancel",
      targetType: "PlatformMaintenanceWindow",
      targetId: id,
      after: { startsAt: w.startsAt, plannedEndsAt: w.endsAt },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, w: await tx.platformMaintenanceWindow.findUniqueOrThrow({ where: { id } }) };
  });
  if (!r.ok) return r;
  clearMaintenanceCache();
  return { ok: true, window: (await view(db, [r.w], now))[0] };
}
export const cancelWindow = (db: PrismaClient, admin: AdminSessionContext, id: string, meta: AuditMeta = {}, now = new Date()) => close(db, admin, id, "cancel", meta, now);
export const endWindow = (db: PrismaClient, admin: AdminSessionContext, id: string, meta: AuditMeta = {}, now = new Date()) => close(db, admin, id, "end", meta, now);
