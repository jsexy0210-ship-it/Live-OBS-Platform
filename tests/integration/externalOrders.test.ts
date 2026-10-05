import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as queueRoute } from "../../app/api/seller/queue/route";
import { loginSeller } from "../../lib/server/auth/login";
import { broadcastDetail } from "../../lib/server/broadcast/detail";
import { aggregateBroadcasts } from "../../lib/server/broadcast/summary";
import { liveProductIds } from "../../lib/server/products/shopCatalog";
import { getQueueSnapshot } from "../../lib/server/queue/read";
import { createHitCard } from "../../lib/server/broadcast/hitCards";
import { cancelExternalOrder, storeExternalOrder, type NormalizedExternalOrder } from "../../lib/server/external/orders";
import { getOverlayState } from "../../lib/server/overlay/state";
import { applyQueueAction } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 외부 쇼핑몰 주문의 주문대기 연결(ExternalOrder + QueueItem 외부 참조). 내부 Order·회원·상품 행은 만들지 않고,
// 기존 큐 동작(개봉 시작·완료·취소·HIT 카드)과 오버레이가 외부 주문 항목에서도 돈다. 웹훅 이벤트를 이 모양으로 바꾸는 파서는 별도(공식 형식 확인 뒤).
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const conn = await db.externalShopConnection.create({ data: { sellerId: seller.id, shopKey: `ext-${seller.slug}`, status: "CONNECTED" } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, owner, conn, ctx };
}
const order = (id: string, over: Partial<NormalizedExternalOrder> = {}): NormalizedExternalOrder => ({
  externalOrderId: id,
  buyerLabel: "별빛팬",
  lines: [{ productLabel: "스타라이트 박스", quantity: 2 }],
  ...over,
});
const counts = async () => ({ orders: await db.order.count(), buyers: await db.buyerMember.count(), products: await db.product.count(), items: await db.orderItem.count() });

describe("외부 주문 저장", () => {
  it("외부 주문과 대기열 항목만 만들고 내부 주문·회원·상품 행은 만들지 않는다. 같은 줄 순번에 이어 붙는다", async () => {
    const s = await shop();
    const buyer = await createBuyer(s.seller.id, s.grade.id);
    const internal = await createPaidOrderItem(s.seller.id, buyer.id);
    await db.queueItem.create({ data: { sellerId: s.seller.id, orderId: internal.order.id, orderItemId: internal.item.id, position: 1, receivedAt: new Date(), nicknameSnapshot: "닉네임", productLabel: "부스터 팩 1팩", quantity: 1 } });
    const before = await counts();
    const r = await storeExternalOrder(db, s.conn.id, order("E-1", { lines: [{ productLabel: "스타라이트 박스", quantity: 2 }, { productLabel: "슬리브", quantity: 1 }] }));
    expect(r).toMatchObject({ ok: true, created: true });
    expect(await counts()).toEqual(before);
    const items = await db.queueItem.findMany({ where: { sellerId: s.seller.id, externalOrderId: { not: null } }, orderBy: { position: "asc" } });
    expect(items.map((i) => [i.position, i.externalLineNo, i.productLabel, i.quantity, i.nicknameSnapshot, i.orderId, i.orderItemId, i.status])).toEqual([
      [2, 0, "스타라이트 박스", 2, "별빛팬", null, null, "WAITING"],
      [3, 1, "슬리브", 1, "별빛팬", null, null, "WAITING"],
    ]);
    expect(await db.externalOrder.findFirstOrThrow()).toMatchObject({ sellerId: s.seller.id, connectionId: s.conn.id, externalOrderId: "E-1", buyerLabel: "별빛팬" });
  });

  it("같은 외부 주문번호는 한 번만(재전송·동시 전송 모두), 방송 중이면 그 방송에 붙는다", async () => {
    const s = await shop();
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    const [a, b] = await Promise.all([storeExternalOrder(db, s.conn.id, order("E-2")), storeExternalOrder(db, s.conn.id, order("E-2"))]);
    expect([a, b].filter((x) => x.ok && x.created)).toHaveLength(1);
    expect(await storeExternalOrder(db, s.conn.id, order("E-2"))).toMatchObject({ ok: true, created: false, queueItemIds: [] });
    expect(await db.externalOrder.count()).toBe(1);
    const q = await db.queueItem.findFirstOrThrow();
    expect(q.broadcastSessionId).toBe(live.id);
  });

  it("잘못된 입력(빈 번호·줄 없음·수량 0·소수·너무 큼·너무 긴 상품명·줄 51개)은 통째로 거절하고 아무것도 저장하지 않는다", async () => {
    const s = await shop();
    const bad: NormalizedExternalOrder[] = [
      order(""),
      order("x".repeat(101)),
      order("A", { lines: [] }),
      order("B", { lines: [{ productLabel: "상품", quantity: 0 }] }),
      order("C", { lines: [{ productLabel: "상품", quantity: 1.5 }] }),
      order("D", { lines: [{ productLabel: "상품", quantity: 10_000 }] }),
      order("E", { lines: [{ productLabel: "가".repeat(101), quantity: 1 }] }),
      order("F", { lines: Array.from({ length: 51 }, () => ({ productLabel: "상품", quantity: 1 })) }),
      order("G", { lines: [{ productLabel: "ok", quantity: 1 }, { productLabel: "", quantity: 1 }] }),
    ];
    for (const o of bad) expect(await storeExternalOrder(db, s.conn.id, o), o.externalOrderId).toEqual({ ok: false, reason: "invalid" });
    expect(await db.externalOrder.count()).toBe(0);
    expect(await db.queueItem.count()).toBe(0);
    // 이름이 없으면 「외부 주문」
    await storeExternalOrder(db, s.conn.id, order("H", { buyerLabel: null }));
    expect((await db.queueItem.findFirstOrThrow()).nicknameSnapshot).toBe("외부 주문");
  });

  it("연결됨이 아닌 연결(해제 대기·다시 연결 필요·해제됨)과 없는 연결에는 저장하지 않는다", async () => {
    const s = await shop();
    for (const status of ["DISCONNECT_PENDING", "REAUTH_REQUIRED", "DISCONNECTED"] as const) {
      await db.externalShopConnection.update({ where: { id: s.conn.id }, data: { status } });
      expect(await storeExternalOrder(db, s.conn.id, order(`S-${status}`))).toEqual({ ok: false, reason: "connection_inactive" });
    }
    expect(await storeExternalOrder(db, "00000000-0000-4000-8000-000000000000", order("none"))).toEqual({ ok: false, reason: "connection_inactive" });
    expect(await db.externalOrder.count()).toBe(0);
  });

  it("판매자 격리: 한 파트너스의 연결로는 다른 파트너스의 대기열에 올라가지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await storeExternalOrder(db, a.conn.id, order("ISO"));
    expect(await db.queueItem.count({ where: { sellerId: a.seller.id } })).toBe(1);
    expect(await db.queueItem.count({ where: { sellerId: b.seller.id } })).toBe(0);
    // 같은 외부 주문번호도 연결이 다르면 따로 저장된다
    await storeExternalOrder(db, b.conn.id, order("ISO"));
    expect(await db.externalOrder.count()).toBe(2);
  });
});

describe("DB 제약: 내부 또는 외부 중 정확히 한쪽", () => {
  it("둘 다 비었거나 둘 다 채웠거나 반쪽만 채운 항목은 DB가 거절한다", async () => {
    const s = await shop();
    const buyer = await createBuyer(s.seller.id, s.grade.id);
    const internal = await createPaidOrderItem(s.seller.id, buyer.id);
    await storeExternalOrder(db, s.conn.id, order("CHK"));
    const eo = await db.externalOrder.findFirstOrThrow();
    const base = { sellerId: s.seller.id, position: 99, receivedAt: new Date(), nicknameSnapshot: "n", productLabel: "p", quantity: 1 };
    await expect(db.queueItem.create({ data: { ...base } })).rejects.toThrow();
    await expect(db.queueItem.create({ data: { ...base, orderId: internal.order.id, orderItemId: internal.item.id, externalOrderId: eo.id, externalLineNo: 5 } })).rejects.toThrow();
    await expect(db.queueItem.create({ data: { ...base, orderId: internal.order.id } })).rejects.toThrow();
    await expect(db.queueItem.create({ data: { ...base, externalOrderId: eo.id } })).rejects.toThrow();
    // 같은 외부 주문 줄 번호 중복도 거절
    await expect(db.queueItem.create({ data: { ...base, externalOrderId: eo.id, externalLineNo: 0 } })).rejects.toThrow();
  });
});

describe("기존 큐 동작이 외부 주문 항목에서도 돈다", () => {
  it("개봉 시작 → 완료 → 되돌리기, 대기 취소, 타이머 조정(재고·결제 처리 없음)", async () => {
    const s = await shop();
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    await storeExternalOrder(db, s.conn.id, order("Q", { lines: [{ productLabel: "A", quantity: 1 }, { productLabel: "B", quantity: 1 }] }));
    const [a, b] = await db.queueItem.findMany({ orderBy: { position: "asc" } });
    expect(a.broadcastSessionId).toBe(live.id);
    const stockBefore = await db.productOption.count();
    expect((await applyQueueAction(db, s.ctx, a.id, "start")).ok).toBe(true);
    expect((await applyQueueAction(db, s.ctx, a.id, "complete")).ok).toBe(true);
    expect((await applyQueueAction(db, s.ctx, a.id, "revert")).ok).toBe(true);
    expect((await applyQueueAction(db, s.ctx, b.id, "timer", { timerSeconds: 30 })).ok).toBe(true);
    expect((await applyQueueAction(db, s.ctx, b.id, "cancel", { reason: "취소 시험" })).ok).toBe(true);
    expect((await db.queueItem.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("OPENING");
    expect((await db.queueItem.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("CANCELLED");
    expect(await db.productOption.count()).toBe(stockBefore);
    expect(await db.stockMovement.count()).toBe(0);
  });

  it("오버레이 주문 알림에 외부 주문이 같은 줄로 보이고(처음 구매 표시), 내부 주문 알림도 그대로다", async () => {
    const s = await shop();
    await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    const buyer = await createBuyer(s.seller.id, s.grade.id);
    const internal = await createPaidOrderItem(s.seller.id, buyer.id);
    await db.queueItem.create({ data: { sellerId: s.seller.id, orderId: internal.order.id, orderItemId: internal.item.id, broadcastSessionId: (await db.broadcastSession.findFirstOrThrow()).id, position: 1, receivedAt: new Date(), nicknameSnapshot: "내부닉", productLabel: "부스터 팩 1팩", quantity: 1 } });
    await storeExternalOrder(db, s.conn.id, order("OV", { lines: [{ productLabel: "스타라이트 박스", quantity: 2 }, { productLabel: "슬리브", quantity: 3 }] }));
    const st = await getOverlayState(db, s.seller.id);
    const events = st.orderEvents as { nickname: string; productLabel: string; quantity: number; moreItems: number; kind: string }[];
    const ext = events.find((e) => e.productLabel === "스타라이트 박스")!;
    expect(ext).toMatchObject({ quantity: 5, moreItems: 1, kind: "FIRST" });
    expect(events.find((e) => e.productLabel === "부스터 팩 1팩")).toMatchObject({ quantity: 1, moreItems: 0 });
  });

  it("HIT 카드를 외부 주문 항목에서 만들 수 있다(내부 주문·회원 연결 없음)", async () => {
    const s = await shop();
    await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    await storeExternalOrder(db, s.conn.id, order("HIT"));
    const q = await db.queueItem.findFirstOrThrow();
    const r = await createHitCard(db, s.ctx, { cardName: "리자몽 SAR", queueItemId: q.id });
    expect(r.ok).toBe(true);
    const card = await db.hitCard.findFirstOrThrow();
    expect(card).toMatchObject({ queueItemId: q.id, buyerMemberId: null, nicknameSnapshot: "별빛팬" });
  });
});

describe("외부 쇼핑몰 취소", () => {
  it("대기 항목만 취소하고 개봉 중·완료는 그대로 둔다. 몇 번 보내도 같다", async () => {
    const s = await shop();
    await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    await storeExternalOrder(db, s.conn.id, order("CAN", { lines: [{ productLabel: "A", quantity: 1 }, { productLabel: "B", quantity: 1 }] }));
    const [a] = await db.queueItem.findMany({ orderBy: { position: "asc" } });
    await applyQueueAction(db, s.ctx, a.id, "start");
    expect(await cancelExternalOrder(db, s.conn.id, "CAN")).toEqual({ ok: true, cancelledItems: 1 });
    expect(await cancelExternalOrder(db, s.conn.id, "CAN")).toEqual({ ok: true, cancelledItems: 0 });
    expect((await db.queueItem.findMany({ orderBy: { position: "asc" } })).map((i) => i.status)).toEqual(["OPENING", "CANCELLED"]);
    expect((await db.externalOrder.findFirstOrThrow()).cancelledAt).not.toBeNull();
    expect(await db.queueItemStatusHistory.count({ where: { reason: "external_cancelled" } })).toBe(1);
    expect(await cancelExternalOrder(db, s.conn.id, "NOPE")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("조회 경로: 외부 주문이 섞인 큐 (출처 필드·raw SQL 집계)", () => {
  async function mixed() {
    const s = await shop();
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    const buyer = await createBuyer(s.seller.id, s.grade.id);
    const internal = await createPaidOrderItem(s.seller.id, buyer.id);
    await db.queueItem.create({ data: { sellerId: s.seller.id, orderId: internal.order.id, orderItemId: internal.item.id, broadcastSessionId: live.id, position: 1, receivedAt: new Date(), nicknameSnapshot: "내부닉", productLabel: "부스터 팩 1팩", quantity: 1 } });
    await storeExternalOrder(db, s.conn.id, order("MIX", { lines: [{ productLabel: "외부 박스", quantity: 2 }] }));
    return { ...s, live, internal };
  }

  it("큐 스냅샷: 외부 항목이 대기 목록에 같은 줄로 나오고 source·externalShopName이 붙는다(내부는 INTERNAL·null), 조회용 관계는 새지 않는다", async () => {
    const s = await mixed();
    const snap = await getQueueSnapshot(db, s.ctx);
    expect(snap.waiting.map((i) => [i.productLabel, i.position, i.source, i.externalShopName])).toEqual([
      ["부스터 팩 1팩", 1, "INTERNAL", null],
      ["외부 박스", 2, "EXTERNAL", s.conn.shopKey],
    ]);
    expect(Object.keys(snap.waiting[1])).not.toContain("externalOrder");
    // 개봉 중·최근 완료에도 같은 모양
    const ext = (await db.queueItem.findFirstOrThrow({ where: { externalOrderId: { not: null } } })).id;
    await applyQueueAction(db, s.ctx, ext, "start");
    expect((await getQueueSnapshot(db, s.ctx)).opening).toMatchObject({ id: ext, source: "EXTERNAL", externalShopName: s.conn.shopKey });
    await applyQueueAction(db, s.ctx, ext, "complete");
    expect((await getQueueSnapshot(db, s.ctx)).recentDone[0]).toMatchObject({ id: ext, source: "EXTERNAL" });
  });

  it("GET /api/seller/queue 라우트도 같은 응답을 준다(로그인 세션)", async () => {
    const s = await mixed();
    const r = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    const res = await queueRoute(new Request("http://localhost:3000/api/seller/queue", { headers: { host: "localhost:3000", cookie: `lo_seller=${r.token}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.waiting).toHaveLength(2);
    expect(body.waiting.map((i: { source: string }) => i.source)).toEqual(["INTERNAL", "EXTERNAL"]);
  });

  it("raw SQL 집계: 방송 요약의 완료 건수는 외부 항목을 포함하고, 방송 상품 목록(상품 조인)은 외부 항목을 건너뛰고 내부 상품만 준다", async () => {
    const s = await mixed();
    const ext = (await db.queueItem.findFirstOrThrow({ where: { externalOrderId: { not: null } } })).id;
    await applyQueueAction(db, s.ctx, ext, "start");
    await applyQueueAction(db, s.ctx, ext, "complete");
    const agg = (await aggregateBroadcasts(db, s.seller.id, [s.live.id])).get(s.live.id)!;
    expect(agg.completed).toBe(1);
    expect(await liveProductIds(db, s.seller.id)).toEqual([s.internal.product.id]);
  });

  it("방송 상세: 외부 주문은 별도 externalOrders 목록(금액·결제 없음)에, HIT 카드는 source가 붙는다. 내부 주문 목록은 그대로", async () => {
    const s = await mixed();
    const ext = (await db.queueItem.findFirstOrThrow({ where: { externalOrderId: { not: null } } })).id;
    await createHitCard(db, s.ctx, { cardName: "리자몽 SAR", queueItemId: ext });
    const d = await broadcastDetail(db, s.ctx, s.live.id);
    expect(d.orders).toHaveLength(1);
    expect(d.externalOrders).toHaveLength(1);
    expect(d.externalOrders[0]).toMatchObject({ source: "EXTERNAL", externalShopName: s.conn.shopKey, nickname: "별빛팬", items: [{ productName: "외부 박스", quantity: 2, status: "WAITING" }], cancelledAt: null, completedAt: null });
    expect(Object.keys(d.externalOrders[0])).not.toContain("totalAmount");
    expect(d.hits[0]).toMatchObject({ source: "EXTERNAL", externalShopName: s.conn.shopKey, order: null });
  });
});

describe("실시간 version: 실제로 바뀔 때만 올린다", () => {
  it("중복·비활성 연결·잘못된 입력·없는 주문 취소는 version을 올리지 않고, 저장·대기 취소는 올린다", async () => {
    const s = await shop();
    const ver = async () => (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion;
    const v0 = await ver();
    await storeExternalOrder(db, s.conn.id, order("V1"));
    const v1 = await ver();
    expect(v1).toBe(v0 + 1);
    await storeExternalOrder(db, s.conn.id, order("V1"));
    await storeExternalOrder(db, s.conn.id, order("", {}));
    await cancelExternalOrder(db, s.conn.id, "NOPE");
    expect(await ver()).toBe(v1);
    await db.externalShopConnection.update({ where: { id: s.conn.id }, data: { status: "DISCONNECT_PENDING" } });
    await storeExternalOrder(db, s.conn.id, order("V2"));
    expect(await ver()).toBe(v1);
    await db.externalShopConnection.update({ where: { id: s.conn.id }, data: { status: "CONNECTED" } });
    expect(await cancelExternalOrder(db, s.conn.id, "V1")).toMatchObject({ ok: true, cancelledItems: 1 });
    expect(await ver()).toBe(v1 + 1);
    // 이미 취소된 주문을 다시 취소해도 올리지 않는다
    await cancelExternalOrder(db, s.conn.id, "V1");
    expect(await ver()).toBe(v1 + 1);
  });
});
