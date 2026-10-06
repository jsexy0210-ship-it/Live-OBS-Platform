import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { ASPECTS } from "../overlay/layout";
import { aggregateBroadcasts } from "./summary";

// 방송 이력(SA-054): 시작 시각 최신순 50개, 기간(KST 날짜, 끝 포함)은 방송 시작일 기준, cursor(마지막 방송 id).
// 방송마다 집계는 요약·상세와 같은 함수(aggregateBroadcasts). 다른 판매자 방송은 보이지 않는다.
export const HISTORY_PAGE = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// KST 날짜 → 그날 0시(KST). 넘치는 날짜(2026-02-30)는 null.
function kstStart(v: string): Date | null {
  if (!DATE.test(v)) return null;
  const d = new Date(`${v}T00:00:00+09:00`);
  return !Number.isNaN(d.getTime()) && new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10) === v ? d : null;
}

type HistoryQuery = { from?: string | null; to?: string | null; cursor?: string | null; layout?: string | null };

export async function broadcastHistory(db: PrismaClient, ctx: TenantContext, q: HistoryQuery) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  return listBroadcastHistory(db, ctx.sellerId, q);
}

// 마스터 관리자 파트너스 상세(MA-012)의 방송 이력. 마스터 관리자 전 역할(platform.read)이 파트너스 하나의 이력을 같은 모양으로 본다. 없는 파트너스는 not_found.
export async function adminSellerBroadcastHistory(db: PrismaClient, admin: AdminSessionContext, sellerId: string, q: HistoryQuery) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  if (!isUuid(sellerId) || !(await db.seller.findUnique({ where: { id: sellerId }, select: { id: true } }))) return { ok: false as const, reason: "not_found" as const };
  return listBroadcastHistory(db, sellerId, q);
}

async function listBroadcastHistory(db: PrismaClient, sellerId: string, q: HistoryQuery) {
  const from = q.from ? kstStart(q.from) : null;
  const to = q.to ? kstStart(q.to) : null;
  if ((q.from && !from) || (q.to && !to) || (from && to && from > to)) return { ok: false as const, reason: "invalid_range" as const };
  const where: Prisma.BroadcastSessionWhereInput = { sellerId };
  // 레이아웃 필터(SA-054): 9x16(세로형)·16x9(가로형). 그 밖의 값은 invalid_range와 같은 400
  if (q.layout) {
    if (!(ASPECTS as readonly string[]).includes(q.layout)) return { ok: false as const, reason: "invalid_range" as const };
    where.layoutAspect = q.layout;
  }
  if (from || to) where.startedAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}) };
  const at = isUuid(q.cursor) ? await db.broadcastSession.findFirst({ where: { id: q.cursor, sellerId }, select: { id: true, startedAt: true } }) : null;
  const rows = await db.broadcastSession.findMany({
    where: at ? { AND: [where, { OR: [{ startedAt: { lt: at.startedAt } }, { startedAt: at.startedAt, id: { lt: at.id } }] }] } : where,
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: HISTORY_PAGE + 1,
  });
  const page = rows.slice(0, HISTORY_PAGE);
  const agg = await aggregateBroadcasts(db, sellerId, page.map((b) => b.id));
  return {
    ok: true as const,
    value: {
      items: page.map((b) => ({
        id: b.id,
        title: b.title,
        status: b.status === "LIVE" ? ("live" as const) : ("ended" as const),
        startedAt: b.startedAt,
        endedAt: b.endedAt,
        // 방송 중 오버레이가 처음 요청한 레이아웃("9x16" 세로형 | "16x9" 가로형). 기록이 없으면 null(화면은 「—」)
        layout: b.layoutAspect === "9x16" || b.layoutAspect === "16x9" ? b.layoutAspect : null,
        summary: agg.get(b.id)!,
      })),
      nextCursor: rows.length > HISTORY_PAGE ? page[page.length - 1].id : null,
    },
  };
}
