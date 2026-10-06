import type { Prisma, PrismaClient } from "@prisma/client";
import { notFound } from "../authz/errors";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { formatCsv, guardText } from "../shop-bulk-io/csv";
import { num } from "../stats/sql";
import { aggregateBroadcasts } from "./summary";

// 방송 상세(SA-055) 추가 지표·메모·리포트. 귀속은 summary.ts와 같다(바뀌지 않는 시각이 방송 [시작, 종료] 안, 방송 중이면 종료 = 지금).
// - avgOpenSeconds: 방송 중 개봉을 마친 주문대기 항목의 (개봉 완료 − 개봉 시작) 평균(초, 반올림). 없으면 null.
// - maxWaiting: 방송 중 들어온 주문대기 항목이 동시에 「대기」였던 최대 건수(들어온 시각 ~ 개봉 시작·취소·완료 중 가장 먼저).
// - hourly: 10분 단위(시계 기준 :00·:10…) 주문 수. 방송 시작이 속한 칸부터 종료가 속한 칸까지 빈 칸도 0으로 채운다.
export const MEMO_MAX = 1000;
export const BUCKET_MS = 600_000;
export const REPORT_ORDER_MAX = 5000;
type Db = PrismaClient | Prisma.TransactionClient;

export async function broadcastInsights(db: Db, sellerId: string, id: string, startedAt: Date, endedAt: Date | null) {
  const [open] = await db.$queryRaw<{ avg: number | null }[]>`
    SELECT avg(extract(epoch FROM (q."doneAt" - q."openingStartedAt")))::float AS avg
    FROM "QueueItem" q JOIN "BroadcastSession" b ON b.id = ${id}::uuid
    WHERE q."sellerId" = ${sellerId}::uuid AND b."sellerId" = ${sellerId}::uuid AND q."doneAt" IS NOT NULL AND q."openingStartedAt" IS NOT NULL
      AND q."doneAt" >= b."startedAt" AND q."doneAt" <= coalesce(b."endedAt", now())`;
  const [wait] = await db.$queryRaw<{ max: number | null }[]>`
    WITH b AS (SELECT "startedAt" AS s, coalesce("endedAt", now()) AS e FROM "BroadcastSession" WHERE id = ${id}::uuid AND "sellerId" = ${sellerId}::uuid),
    ev AS (
      SELECT q."receivedAt" AS t, 1 AS d FROM "QueueItem" q, b WHERE q."sellerId" = ${sellerId}::uuid AND q."receivedAt" >= b.s AND q."receivedAt" <= b.e
      UNION ALL
      SELECT coalesce(q."openingStartedAt", q."cancelledAt", q."doneAt", b.e), -1 FROM "QueueItem" q, b WHERE q."sellerId" = ${sellerId}::uuid AND q."receivedAt" >= b.s AND q."receivedAt" <= b.e
    )
    SELECT max(r)::int AS max FROM (SELECT sum(d) OVER (ORDER BY t, d ROWS UNBOUNDED PRECEDING) AS r FROM ev) x`;
  const end = endedAt ?? new Date();
  const first = Math.floor(startedAt.getTime() / BUCKET_MS);
  const last = Math.max(first, Math.floor(end.getTime() / BUCKET_MS));
  const rows = await db.$queryRaw<{ b: bigint; n: number }[]>`
    SELECT floor(extract(epoch FROM o."createdAt") / 600)::bigint AS b, count(*)::int AS n
    FROM "Order" o JOIN "BroadcastSession" s ON s.id = ${id}::uuid
    WHERE o."sellerId" = ${sellerId}::uuid AND s."sellerId" = ${sellerId}::uuid AND o."createdAt" >= s."startedAt" AND o."createdAt" <= coalesce(s."endedAt", now())
    GROUP BY 1`;
  const counts = new Map(rows.map((r) => [Number(r.b), num(r.n)]));
  const hourly: { at: Date; orders: number }[] = [];
  for (let k = first; k <= last; k++) hourly.push({ at: new Date(k * BUCKET_MS), orders: counts.get(k) ?? 0 });
  return { avgOpenSeconds: open?.avg == null ? null : Math.round(open.avg), maxWaiting: wait?.max == null ? 0 : Math.max(0, num(wait.max)), hourly };
}

// 방송 메모 저장(방송당 한 칸). 방송 진행(BROADCAST_RUN) 권한, 대리 조회 불가. 빈 글자는 지우기. 다른 판매자 방송은 404.
export async function saveBroadcastMemo(db: PrismaClient, ctx: TenantContext, id: string, memo: unknown, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  if (typeof memo !== "string" || memo.length > MEMO_MAX) return { ok: false as const, reason: "bad_request" as const };
  const value = memo.trim() === "" ? null : memo;
  const cur = await db.broadcastSession.findFirst({ where: { id, sellerId: ctx.sellerId }, select: { id: true } }).catch(() => null);
  if (!cur) throw notFound();
  await db.broadcastSession.update({ where: { id }, data: { memo: value } });
  await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "broadcast.memo.update", targetType: "BroadcastSession", targetId: id, after: { length: value?.length ?? 0 }, ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true as const, memo: value };
}

const pad = (n: number) => String(n).padStart(2, "0");
const kst = (d: Date | null) => {
  if (!d) return "";
  const t = new Date(d.getTime() + 9 * 3_600_000);
  return `${t.getUTCFullYear()}.${pad(t.getUTCMonth() + 1)}.${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};

// 리포트 내보내기(CSV, 방송 상세 화면 「리포트 내보내기」): 끝난 방송만(방송 중이면 live). 위쪽 요약 몇 줄 + 주문 표(최대 5,000건). 구매자는 방송 닉네임만.
export async function exportBroadcastReport(db: PrismaClient, ctx: TenantContext, id: string, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  const session = await db.broadcastSession.findFirst({ where: { id, sellerId: ctx.sellerId } }).catch(() => null);
  if (!session) throw notFound();
  if (session.status === "LIVE") return { ok: false as const, reason: "live" as const };
  const end = session.endedAt ?? session.startedAt;
  const [agg, ins, orders] = await Promise.all([
    aggregateBroadcasts(db, ctx.sellerId, [id]),
    broadcastInsights(db, ctx.sellerId, id, session.startedAt, session.endedAt),
    db.order.findMany({
      where: { sellerId: ctx.sellerId, legalHoldAt: null, createdAt: { gte: session.startedAt, lte: end } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: REPORT_ORDER_MAX + 1,
      select: { orderNo: true, status: true, broadcastNicknameSnapshot: true, totalAmount: true, refundAmount: true, createdAt: true, items: { select: { productNameSnapshot: true, quantity: true }, orderBy: { id: "asc" } } },
    }),
  ]);
  const a = agg.get(id)!;
  const truncated = orders.length > REPORT_ORDER_MAX;
  const csv = formatCsv([
    ["방송", guardText(session.title ?? ""), "일시", `${kst(session.startedAt)} ~ ${kst(session.endedAt)}`],
    ["주문", String(a.orders), "완료", String(a.completed), "뺀 주문", String(a.cancelled), "매출", String(a.sales), "HIT", String(a.hits), "평균 오픈(초)", ins.avgOpenSeconds === null ? "" : String(ins.avgOpenSeconds), "최대 대기(건)", String(ins.maxWaiting)],
    [],
    ["주문 시각", "구매자", "상품", "금액", "환불", "상태"],
    ...orders.slice(0, REPORT_ORDER_MAX).map((o) => [
      kst(o.createdAt),
      guardText(o.broadcastNicknameSnapshot ?? ""),
      guardText(o.items.map((i) => `${i.productNameSnapshot}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ")),
      String(o.totalAmount),
      o.refundAmount == null ? "" : String(o.refundAmount),
      o.status,
    ]),
  ]);
  await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "broadcast.report.export", targetType: "BroadcastSession", targetId: id, after: { orders: Math.min(orders.length, REPORT_ORDER_MAX), truncated }, ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true as const, csv, truncated };
}
