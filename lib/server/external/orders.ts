import { Prisma, type PrismaClient } from "@prisma/client";
import { notifySellerChanged } from "../realtime/notify";
import { cleanText } from "../text/clean";

// 외부 쇼핑몰 주문을 주문대기(QueueItem)에 올린다. 내부 Order·회원·상품 행은 만들지 않는다(가짜 행 금지). 재고·결제·적립금·배송은 외부 쇼핑몰이 다룬다.
// 웹훅 이벤트 본문을 이 모양(NormalizedExternalOrder)으로 바꾸는 일(파서)은 공식 이벤트 형식 확인 뒤에 따로 넣는다(docs/EXTERNAL_SHOP.md 「미검증」).
export type NormalizedExternalOrder = {
  externalOrderId: string;
  // 방송에 보이는 이름(닉네임·가린 이름). 없으면 「외부 주문」
  buyerLabel: string | null;
  lines: { productLabel: string; quantity: number }[];
};

export const MAX_LINES = 50;
export const MAX_LINE_QUANTITY = 9999;
const FALLBACK_LABEL = "외부 주문";

type Parsed = { externalOrderId: string; buyerLabel: string; lines: { productLabel: string; quantity: number }[] };

// 외부에서 온 값은 저장 전에 한 곳에서 검증·정리한다(길이·제어문자·수량 범위). 하나라도 틀리면 통째로 거절한다.
function parse(o: NormalizedExternalOrder): Parsed | null {
  const externalOrderId = typeof o.externalOrderId === "string" ? o.externalOrderId.trim() : "";
  if (!externalOrderId || externalOrderId.length > 100 || /[\u0000-\u001f]/.test(externalOrderId)) return null;
  const buyerLabel = o.buyerLabel === null || o.buyerLabel === undefined ? FALLBACK_LABEL : (cleanText(o.buyerLabel, 50) ?? FALLBACK_LABEL);
  if (!Array.isArray(o.lines) || o.lines.length < 1 || o.lines.length > MAX_LINES) return null;
  const lines: Parsed["lines"] = [];
  for (const l of o.lines) {
    const label = cleanText(l?.productLabel, 100);
    if (!label || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_LINE_QUANTITY) return null;
    lines.push({ productLabel: label, quantity: l.quantity });
  }
  return { externalOrderId, buyerLabel, lines };
}

export type StoreResult = { ok: true; created: boolean; queueItemIds: string[] } | { ok: false; reason: "invalid" | "connection_inactive" };

// 같은 연결의 같은 외부 주문번호는 한 번만 올린다(웹훅 재전송·보정 중복 안전). 연결이 「연결됨」이 아니면(해제 대기·다시 연결 필요·해제됨) 올리지 않는다.
// 주문대기 순서는 내부 주문과 같은 줄(같은 방송·같은 position 순번)이다. 판매자 행을 잠가 순번이 겹치지 않게 한다.
export async function storeExternalOrder(db: PrismaClient, connectionId: string, order: NormalizedExternalOrder): Promise<StoreResult> {
  const p = parse(order);
  if (!p) return { ok: false, reason: "invalid" };
  const conn = await db.externalShopConnection.findUnique({ where: { id: connectionId }, select: { id: true, sellerId: true } });
  if (!conn) return { ok: false, reason: "connection_inactive" };
  const out = await db.$transaction(async (tx) => {
    const seller = await tx.seller.update({ where: { id: conn.sellerId }, data: { liveVersion: { increment: 1 } }, select: { liveVersion: true } });
    const cur = await tx.externalShopConnection.findFirst({ where: { id: conn.id, sellerId: conn.sellerId, status: "CONNECTED" }, select: { id: true } });
    if (!cur) return { inactive: true as const };
    const dup = await tx.externalOrder.findUnique({ where: { connectionId_externalOrderId: { connectionId: conn.id, externalOrderId: p.externalOrderId } }, select: { id: true } });
    if (dup) return { created: false as const, queueItemIds: [] as string[], version: seller.liveVersion };
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const eo = await tx.externalOrder.create({ data: { sellerId: conn.sellerId, connectionId: conn.id, externalOrderId: p.externalOrderId, buyerLabel: p.buyerLabel, receivedAt: now } });
    const live = await tx.broadcastSession.findFirst({ where: { sellerId: conn.sellerId, status: "LIVE" }, select: { id: true } });
    const scope = { sellerId: conn.sellerId, broadcastSessionId: live?.id ?? null };
    let position = (await tx.queueItem.aggregate({ where: scope, _max: { position: true } }))._max.position ?? 0;
    const queueItemIds: string[] = [];
    for (const [i, l] of p.lines.entries()) {
      const q = await tx.queueItem.create({
        data: { ...scope, externalOrderId: eo.id, externalLineNo: i, position: ++position, receivedAt: now, nicknameSnapshot: p.buyerLabel, productLabel: l.productLabel, quantity: l.quantity },
      });
      queueItemIds.push(q.id);
    }
    return { created: true as const, queueItemIds, version: seller.liveVersion };
  }).catch((e) => {
    // 같은 외부 주문을 동시에 두 번 받으면 유니크로 한쪽만 남는다
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { created: false as const, queueItemIds: [] as string[], version: null };
    throw e;
  });
  if ("inactive" in out) return { ok: false, reason: "connection_inactive" };
  if (out.created && out.version !== null) await notifySellerChanged(db, conn.sellerId, out.version);
  return { ok: true, created: out.created, queueItemIds: out.queueItemIds };
}

export type CancelResult = { ok: true; cancelledItems: number } | { ok: false; reason: "not_found" };

// 외부 쇼핑몰에서 주문이 취소·환불되면 아직 「대기」인 항목만 취소로 바꾼다. 이미 개봉 중·완료인 항목은 판매자가 판단한다(그대로 둠). 몇 번 보내도 같은 결과.
export async function cancelExternalOrder(db: PrismaClient, connectionId: string, externalOrderId: string): Promise<CancelResult> {
  const conn = await db.externalShopConnection.findUnique({ where: { id: connectionId }, select: { id: true, sellerId: true } });
  if (!conn) return { ok: false, reason: "not_found" };
  const out = await db.$transaction(async (tx) => {
    const seller = await tx.seller.update({ where: { id: conn.sellerId }, data: { liveVersion: { increment: 1 } }, select: { liveVersion: true } });
    const eo = await tx.externalOrder.findUnique({ where: { connectionId_externalOrderId: { connectionId: conn.id, externalOrderId } }, select: { id: true, sellerId: true, cancelledAt: true } });
    if (!eo || eo.sellerId !== conn.sellerId) return null;
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    if (!eo.cancelledAt) await tx.externalOrder.update({ where: { id: eo.id }, data: { cancelledAt: now } });
    const waiting = await tx.queueItem.findMany({ where: { sellerId: conn.sellerId, externalOrderId: eo.id, status: "WAITING" }, select: { id: true } });
    for (const w of waiting) {
      await tx.queueItem.update({ where: { id: w.id }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: "외부 쇼핑몰에서 취소됨", version: { increment: 1 } } });
      await tx.queueItemStatusHistory.create({ data: { sellerId: conn.sellerId, queueItemId: w.id, fromStatus: "WAITING", toStatus: "CANCELLED", actorType: "SYSTEM", reason: "external_cancelled", createdAt: now } });
    }
    return { count: waiting.length, version: seller.liveVersion };
  });
  if (!out) return { ok: false, reason: "not_found" };
  if (out.count > 0) await notifySellerChanged(db, conn.sellerId, out.version);
  return { ok: true, cancelledItems: out.count };
}
