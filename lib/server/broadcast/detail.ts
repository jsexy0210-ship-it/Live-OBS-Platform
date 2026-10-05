import type { PrismaClient } from "@prisma/client";
import { notFound } from "../authz/errors";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { aggregateBroadcasts } from "./summary";

// 방송 상세(SA-055): 집계 + 그 방송 주문 목록 + HIT 카드. 귀속은 summary.ts와 같다(주문 createdAt·HIT createdAt이 방송 [시작, 종료] 안).
// - 주문은 방송 중 들어온 순서(오래된 것부터), cursor(마지막 주문 id)로 50개씩. 탈퇴 등으로 분리 보관된 주문(legalHoldAt)은 일반 조회에서 빠진다.
// - 구매자는 방송 닉네임 스냅숏만 보여 준다(이름·연락처 없음). 완료 시각은 그 주문 주문대기 항목의 개봉 완료(doneAt) 가운데 가장 늦은 시각.
// - 다른 판매자 방송 id는 404.
export const DETAIL_ORDER_PAGE = 50;
export const DETAIL_HIT_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export async function broadcastDetail(db: PrismaClient, ctx: TenantContext, id: string, cursor?: string | null) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  if (!isUuid(id)) throw notFound();
  const session = await db.broadcastSession.findFirst({ where: { id, sellerId: ctx.sellerId } });
  if (!session) throw notFound();
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const end = session.endedAt ?? now;
  const window = { gte: session.startedAt, lte: end };
  const at = isUuid(cursor)
    ? await db.order.findFirst({ where: { id: cursor, sellerId: ctx.sellerId, createdAt: window }, select: { id: true, createdAt: true } })
    : null;
  const [agg, rows, hits] = await Promise.all([
    aggregateBroadcasts(db, ctx.sellerId, [session.id]),
    db.order.findMany({
      where: {
        sellerId: ctx.sellerId,
        legalHoldAt: null,
        createdAt: window,
        ...(at ? { OR: [{ createdAt: { gt: at.createdAt } }, { createdAt: at.createdAt, id: { gt: at.id } }] } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: DETAIL_ORDER_PAGE + 1,
      select: {
        id: true,
        orderNo: true,
        status: true,
        broadcastNicknameSnapshot: true,
        totalAmount: true,
        refundAmount: true,
        createdAt: true,
        paidAt: true,
        items: { select: { productNameSnapshot: true, optionNameSnapshot: true, quantity: true, unitPrice: true }, orderBy: { id: "asc" } },
        queueItems: { select: { doneAt: true } },
      },
    }),
    db.hitCard.findMany({
      where: { sellerId: ctx.sellerId, createdAt: window },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: DETAIL_HIT_LIMIT,
      select: { id: true, cardName: true, note: true, nicknameSnapshot: true, createdAt: true, queueItem: { select: { order: { select: { id: true, orderNo: true } } } } },
    }),
  ]);
  const page = rows.slice(0, DETAIL_ORDER_PAGE);
  const doneTimes = (o: (typeof page)[number]) => o.queueItems.map((q) => q.doneAt).filter((d): d is Date => !!d);
  return {
    broadcast: { id: session.id, title: session.title, status: session.status === "LIVE" ? ("live" as const) : ("ended" as const), startedAt: session.startedAt, endedAt: session.endedAt },
    summary: agg.get(session.id)!,
    orders: page.map((o) => {
      const done = doneTimes(o);
      return {
        id: o.id,
        orderNo: o.orderNo,
        nickname: o.broadcastNicknameSnapshot,
        items: o.items.map((i) => ({ productName: i.productNameSnapshot, optionName: i.optionNameSnapshot, quantity: i.quantity, unitPrice: i.unitPrice })),
        totalAmount: o.totalAmount,
        refundAmount: o.refundAmount,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        completedAt: done.length > 0 && done.length === o.queueItems.length ? new Date(Math.max(...done.map((d) => d.getTime()))) : null,
      };
    }),
    nextCursor: rows.length > DETAIL_ORDER_PAGE ? page[page.length - 1].id : null,
    hits: hits.map((h) => ({ id: h.id, cardName: h.cardName, note: h.note, nickname: h.nicknameSnapshot, order: h.queueItem ? h.queueItem.order : null, createdAt: h.createdAt })),
  };
}
