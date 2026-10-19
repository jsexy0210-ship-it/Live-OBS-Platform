import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { ASPECTS } from "../overlay/layout";
import { writeAudit } from "../audit/log";
import { formatCsv, guardText } from "../shop-bulk-io/csv";
import { aggregateBroadcasts } from "./summary";

// 방송 이력(SA-054): 시작 시각 최신순 10개, 기간(KST 날짜, 끝 포함)은 방송 시작일 기준, cursor(마지막 방송 id).
// 방송마다 집계는 요약·상세와 같은 함수(aggregateBroadcasts). 다른 판매자 방송은 보이지 않는다.
export const HISTORY_PAGE = 10;

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

function historyWhere(sellerId: string, q: HistoryQuery) {
  const from = q.from ? kstStart(q.from) : null;
  const to = q.to ? kstStart(q.to) : null;
  if ((q.from && !from) || (q.to && !to) || (from && to && from > to)) return null;
  const where: Prisma.BroadcastSessionWhereInput = { sellerId };
  // 레이아웃 필터(SA-054): 9x16(세로형)·16x9(가로형). 그 밖의 값은 invalid_range와 같은 400
  if (q.layout) {
    if (!(ASPECTS as readonly string[]).includes(q.layout)) return null;
    where.layoutAspect = q.layout;
  }
  if (from || to) where.startedAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}) };
  return where;
}

async function listBroadcastHistory(db: PrismaClient, sellerId: string, q: HistoryQuery) {
  const where = historyWhere(sellerId, q);
  if (!where) return { ok: false as const, reason: "invalid_range" as const };
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
      monthSummary: await monthBroadcastSummary(db, sellerId),
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

// 이번 달(KST 1일 0시~지금) 요약 4칸: 방송 수와 방송 시간 합(방송 중이면 지금까지), 주문 수 합, 방송당 평균 매출(매출 합 ÷ 방송 수, 반올림), 평균 오픈 시간(초).
// 기간·레이아웃 필터와 상관없이 항상 이번 달 기준. 평균 오픈 시간은 방송 상세와 같은 정의(개봉 완료 − 개봉 시작 평균). 방송이 없으면 0과 null.
export async function monthBroadcastSummary(db: PrismaClient, sellerId: string, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const monthStart = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 1) - 9 * 3_600_000);
  const rows = await db.broadcastSession.findMany({ where: { sellerId, startedAt: { gte: monthStart, lte: now } }, select: { id: true, startedAt: true, endedAt: true } });
  const agg = await aggregateBroadcasts(db, sellerId, rows.map((b) => b.id));
  let orders = 0;
  let sales = 0;
  for (const b of rows) {
    const a = agg.get(b.id);
    orders += a?.orders ?? 0;
    sales += a?.sales ?? 0;
  }
  const seconds = rows.reduce((t, b) => t + Math.max(0, Math.floor(((b.endedAt ?? now).getTime() - b.startedAt.getTime()) / 1000)), 0);
  const open = rows.length === 0 ? [] : await db.$queryRaw<{ avg: number | null }[]>`
    SELECT avg(extract(epoch FROM (q."doneAt" - q."openingStartedAt")))::float AS avg
    FROM "QueueItem" q JOIN "BroadcastSession" b ON b.id = ANY(${rows.map((b) => b.id)}::uuid[]) AND q."doneAt" >= b."startedAt" AND q."doneAt" <= coalesce(b."endedAt", ${now})
    WHERE q."sellerId" = ${sellerId}::uuid AND q."doneAt" IS NOT NULL AND q."openingStartedAt" IS NOT NULL`;
  const avg = open[0]?.avg;
  return {
    broadcasts: rows.length,
    seconds,
    orders,
    avgSales: rows.length === 0 ? 0 : Math.round(sales / rows.length),
    avgOpenSeconds: avg == null ? null : Math.round(avg),
  };
}

const HISTORY_EXPORT_MAX = 5_000;
const pad = (n: number) => String(n).padStart(2, "0");
const kstText = (d: Date) => {
  const t = new Date(d.getTime() + 9 * 3_600_000);
  return `${t.getUTCFullYear()}.${pad(t.getUTCMonth() + 1)}.${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};

// 방송 기록 내보내기(SA-054 「내보내기」, CSV): 지금 기간·레이아웃 조건에 맞는 방송 전체(쪽과 상관없이 최신순, 최대 5,000건). BROADCAST_RUN 권한. 진행 중 방송은 종료 시각을 비운다.
export async function exportBroadcastHistory(db: PrismaClient, ctx: TenantContext, q: HistoryQuery, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const where = historyWhere(ctx.sellerId, q);
  if (!where) return { ok: false as const, reason: "invalid_range" as const };
  const rows = await db.broadcastSession.findMany({ where, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: HISTORY_EXPORT_MAX + 1 });
  const truncated = rows.length > HISTORY_EXPORT_MAX;
  const page = rows.slice(0, HISTORY_EXPORT_MAX);
  const agg = await aggregateBroadcasts(db, ctx.sellerId, page.map((b) => b.id));
  const csv = formatCsv([
    ["제목", "시작", "종료", "시간(초)", "주문", "완료", "뺀 주문", "HIT", "매출", "레이아웃", "상태"],
    ...page.map((b) => {
      const a = agg.get(b.id)!;
      return [
        guardText(b.title ?? ""),
        kstText(b.startedAt),
        b.endedAt ? kstText(b.endedAt) : "",
        b.endedAt ? String(Math.max(0, Math.floor((b.endedAt.getTime() - b.startedAt.getTime()) / 1000))) : "",
        String(a.orders),
        String(a.completed),
        String(a.cancelled),
        String(a.hits),
        String(a.sales),
        b.layoutAspect === "9x16" ? "세로형" : b.layoutAspect === "16x9" ? "가로형" : "",
        b.status === "LIVE" ? "진행 중" : "종료",
      ];
    }),
  ]);
  await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "broadcast.history.export", targetType: "BroadcastSession", after: { rows: page.length, truncated }, ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true as const, csv, truncated };
}
