import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as overlayState } from "../../app/api/overlay/[token]/state/route";
import { prisma } from "../../lib/server/db";
import { HALL_MAX, ORDER_EVENT_MAX, RANKING_MAX } from "../../lib/server/overlay/state";
import { issueOverlayToken } from "../../lib/server/overlay/token";
import { markOrderPaid, startBroadcast } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 오버레이 공개 state 보강: 신규 주문 이벤트(최근 30초·10건·FIRST/REPEAT/VIP), 쇼핑몰 이름·주소, 명예의 전당(최근 등록 순 10건).
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function shop() {
  const { seller, grade } = await createSeller();
  const vipGrade = await db.memberGrade.create({ data: { sellerId: seller.id, displayName: "VIP", sortOrder: 4, systemKey: "VIP" } });
  const user = await createSellerUser(seller.id, "BROADCASTER");
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: user.id, isOwner: false, permissions: user.permissions, readOnly: false };
  const ownerCtx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: owner.permissions, readOnly: false };
  // 결제 대기로 만든 뒤 결제 완료 처리(markOrderPaid)를 거쳐 주문대기 항목을 만든다. extra만큼 품목을 더한다.
  const pay = async (buyerId: string, nickname: string, extra = 0) => {
    const { order, item } = await createPaidOrderItem(seller.id, buyerId);
    for (let i = 0; i < extra; i++) {
      await db.orderItem.create({
        // 첫 품목보다 늦은 시각으로 넣어 주문대기 순서(대표 품목)가 첫 품목으로 정해지게 한다(같은 시각이면 id 순서라 흔들림)
        data: {
          sellerId: seller.id,
          orderId: order.id,
          productId: item.productId,
          optionId: item.optionId,
          productNameSnapshot: "추가 팩",
          optionNameSnapshot: "",
          unitPrice: 5000,
          quantity: 2,
          createdAt: new Date(item.createdAt.getTime() + 1000 * (i + 1)),
        },
      });
    }
    await db.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT", paidAt: null, broadcastNicknameSnapshot: nickname } });
    const r = await markOrderPaid(db, { sellerId: seller.id, orderId: order.id });
    if (!r.ok) throw new Error(r.reason);
    return { orderId: order.id, queueItemIds: r.value.queueItemIds };
  };
  const token = await issueOverlayToken(db, ownerCtx);
  const get = async (headers: Record<string, string> = {}) => {
    const res = await overlayState(new Request(`http://localhost:3000/api/overlay/${token}/state`, { headers }), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    return res.json();
  };
  return { seller, grade, vipGrade, ctx, pay, get };
}

describe("신규 주문 이벤트", () => {
  it("방송 중 최근 주문을 최근 순으로 주고, 첫 주문·재주문·VIP를 나눈다. 품목이 여럿이면 한 건으로 묶는다", async () => {
    const s = await shop();
    await startBroadcast(db, s.ctx);
    const a = await createBuyer(s.seller.id, s.grade.id);
    const v = await createBuyer(s.seller.id, s.vipGrade.id);
    const first = await s.pay(a.id, "첫손님");
    const again = await s.pay(a.id, "첫손님", 2);
    const vip = await s.pay(v.id, "큰손");
    const body = await s.get();
    expect(body.orderEvents).toEqual([
      { id: vip.queueItemIds[0], kind: "VIP", nickname: "큰손", productLabel: "부스터 팩 1팩", quantity: 1, moreItems: 0, occurredAt: expect.any(String) },
      { id: again.queueItemIds[0], kind: "REPEAT", nickname: "첫손님", productLabel: "부스터 팩 1팩", quantity: 5, moreItems: 2, occurredAt: expect.any(String) },
      { id: first.queueItemIds[0], kind: "FIRST", nickname: "첫손님", productLabel: "부스터 팩 1팩", quantity: 1, moreItems: 0, occurredAt: expect.any(String) },
    ]);
    // 주문 id·회원 id·휴대폰·금액은 내보내지 않는다
    const raw = JSON.stringify(body);
    for (const key of [first.orderId, "orderId", "buyerMemberId", "phone", "totalAmount", "unitPrice", a.phone, v.phone]) expect(raw).not.toContain(key);
  });

  it("30초가 지났거나 취소된 주문, 방송 중이 아닐 때 들어온 주문은 빠진다. 다른 쇼핑몰 주문은 보이지 않는다", async () => {
    const s = await shop();
    const other = await shop();
    const a = await createBuyer(s.seller.id, s.grade.id);
    await s.pay(a.id, "방송전");
    expect((await s.get()).orderEvents).toEqual([]);
    await startBroadcast(db, s.ctx);
    await startBroadcast(db, other.ctx);
    const old = await s.pay(a.id, "지난주문");
    await db.queueItem.update({ where: { id: old.queueItemIds[0] }, data: { receivedAt: new Date(Date.now() - 31_000) } });
    const cancelled = await s.pay(a.id, "취소됨");
    await db.queueItem.update({ where: { id: cancelled.queueItemIds[0] }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const ok = await s.pay(a.id, "남는주문");
    const b = await createBuyer(other.seller.id, other.grade.id);
    await other.pay(b.id, "옆가게");
    expect((await s.get()).orderEvents.map((e: { id: string }) => e.id)).toEqual([ok.queueItemIds[0]]);
    expect((await other.get()).orderEvents.map((e: { nickname: string }) => e.nickname)).toEqual(["옆가게"]);
  });

  it(`최대 ${ORDER_EVENT_MAX}건`, async () => {
    const s = await shop();
    await startBroadcast(db, s.ctx);
    const a = await createBuyer(s.seller.id, s.grade.id);
    const made = [];
    for (let i = 0; i < ORDER_EVENT_MAX + 2; i++) made.push(await s.pay(a.id, `손님${i}`));
    const events = (await s.get()).orderEvents;
    expect(events).toHaveLength(ORDER_EVENT_MAX);
    expect(events[0].nickname).toBe(`손님${ORDER_EVENT_MAX + 1}`);
  });
});

describe("쇼핑몰·명예의 전당", () => {
  it("쇼핑몰 이름과 공개 쇼핑몰 주소를 준다. 요청 주소를 알 수 없으면 주소는 null", async () => {
    const s = await shop();
    expect((await s.get({ host: "localhost:3000" })).shop).toEqual({ name: s.seller.shopName, url: `http://localhost:3000/shop/${s.seller.slug}` });
    expect((await s.get({ host: "bad host" })).shop).toEqual({ name: s.seller.shopName, url: null });
  });

  it(`명예의 전당은 지금 방송의 HIT 카드 최근 등록 순 ${HALL_MAX}건`, async () => {
    const s = await shop();
    const live = await startBroadcast(db, s.ctx);
    if (!live.ok) throw new Error(live.reason);
    const session = await db.broadcastSession.findFirstOrThrow({ where: { sellerId: s.seller.id, status: "LIVE" } });
    const base = Date.now();
    for (let i = 0; i < HALL_MAX + 2; i++) {
      await db.hitCard.create({ data: { sellerId: s.seller.id, broadcastSessionId: session.id, nicknameSnapshot: `당첨${i}`, cardName: `카드${i}`, createdAt: new Date(base - (HALL_MAX + 2 - i) * 1000) } });
    }
    const hits = (await s.get()).hits;
    expect(hits).toHaveLength(HALL_MAX);
    expect(hits.map((h: { cardName: string }) => h.cardName)).toEqual(Array.from({ length: HALL_MAX }, (_, i) => `카드${HALL_MAX + 1 - i}`));
  });
});

describe("구매 랭킹", () => {
  it("지금 방송 구매 수량이 많은 순(같으면 먼저 산 사람이 앞, 같은 수량은 같은 순위). 닉네임·수량·순위만 내보낸다", async () => {
    const s = await shop();
    await startBroadcast(db, s.ctx);
    const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(() => createBuyer(s.seller.id, s.grade.id)));
    await s.pay(a.id, "가나", 1); // 3
    await s.pay(b.id, "다라", 2); // 5
    await s.pay(c.id, "마바"); // 1
    await s.pay(d.id, "사아"); // 1 (c보다 늦게)
    await s.pay(a.id, "가나-새닉", 1); // a: 6, 가장 최근 닉네임
    const body = await s.get();
    expect(body.purchaseRanking).toEqual([
      { rank: 1, nickname: "가나-새닉", quantity: 6 },
      { rank: 2, nickname: "다라", quantity: 5 },
      { rank: 3, nickname: "마바", quantity: 1 },
      { rank: 3, nickname: "사아", quantity: 1 },
    ]);
    const raw = JSON.stringify(body.purchaseRanking);
    for (const key of ["buyerMemberId", "phone", "totalAmount", "unitPrice", "orderId", a.id, a.phone, b.phone, a.name]) expect(raw).not.toContain(key);
  });

  it("방송 중이 아니면 비어 있고, 취소·환불·결제 전 주문은 세지 않고 부분 환불은 뺀다", async () => {
    const s = await shop();
    const a = await createBuyer(s.seller.id, s.grade.id);
    expect((await s.get()).purchaseRanking).toEqual([]);
    await s.pay(a.id, "방송전"); // 방송 시작 때 방송에 붙으므로 1개로 센다
    await startBroadcast(db, s.ctx);
    const keep = await s.pay(a.id, "남음");
    const cancelled = await s.pay(a.id, "취소");
    await db.queueItem.update({ where: { id: cancelled.queueItemIds[0] }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const refunded = await s.pay(a.id, "환불");
    await db.order.update({ where: { id: refunded.orderId }, data: { status: "REFUNDED" } });
    const partial = await s.pay(a.id, "부분환불", 1); // 1개 + 2개 품목 중 1개 환불 → 2개(남음 1 + 방송전 1 + 2 = 4)
    await db.orderItem.updateMany({ where: { orderId: partial.orderId, quantity: 2 }, data: { refundedQuantity: 1 } });
    const unpaid = await s.pay(a.id, "결제전");
    await db.order.update({ where: { id: unpaid.orderId }, data: { status: "PENDING_PAYMENT" } });
    expect(keep.queueItemIds).toHaveLength(1);
    expect((await s.get()).purchaseRanking).toEqual([{ rank: 1, nickname: "부분환불", quantity: 4 }]);
  });

  it(`최대 ${RANKING_MAX}명이고 다른 쇼핑몰 주문은 섞이지 않는다`, async () => {
    const s = await shop();
    const other = await shop();
    await startBroadcast(db, s.ctx);
    await startBroadcast(db, other.ctx);
    for (let i = 0; i < RANKING_MAX + 2; i++) await s.pay((await createBuyer(s.seller.id, s.grade.id)).id, `손님${i}`);
    await other.pay((await createBuyer(other.seller.id, other.grade.id)).id, "옆가게", 3);
    const mine = (await s.get()).purchaseRanking;
    expect(mine).toHaveLength(RANKING_MAX);
    expect(JSON.stringify(mine)).not.toContain("옆가게");
    expect((await other.get()).purchaseRanking).toEqual([{ rank: 1, nickname: "옆가게", quantity: 7 }]);
  });

  it("닉네임은 방송 화면용으로 정리한다(제어 문자 제거·20자 제한)", async () => {
    const s = await shop();
    await startBroadcast(db, s.ctx);
    await s.pay((await createBuyer(s.seller.id, s.grade.id)).id, `긴${"가".repeat(30)}\u202e`);
    const [row] = (await s.get()).purchaseRanking;
    expect(row.nickname).toBe(`긴${"가".repeat(19)}…`);
  });
});

describe("이벤트 할인 카드", () => {
  const at = (ms: number) => new Date(Date.now() + ms);
  const event = (rate: number, startMs: number, endMs: number) => ({ eventDiscountType: "RATE" as const, eventDiscountValue: rate, eventStartsAt: at(startMs), eventEndsAt: at(endMs) });

  it("이벤트가 없으면 null. 기간 안·판매 중인 상품 중 마감이 가장 가까운 1개와 나머지 개수를 준다", async () => {
    const s = await shop();
    expect((await s.get()).eventCard).toBeNull();
    const mk = (name: string, data: object) => db.product.create({ data: { sellerId: s.seller.id, name, price: 10000, status: "ON_SALE", ...data } });
    await mk("먼 마감", event(10, -3600_000, 5 * 24 * 3600_000));
    await mk("곧 마감", event(30, -3600_000, 90 * 60_000));
    await mk("시작 전", event(50, 3600_000, 7200_000));
    await mk("이미 끝남", event(50, -7200_000, -3600_000));
    await mk("숨김", { ...event(50, -3600_000, 60_000), status: "HIDDEN" });
    await mk("삭제", { ...event(50, -3600_000, 60_000), deletedAt: new Date() });
    const card = (await s.get()).eventCard;
    expect(card).toMatchObject({ productName: "곧 마감", price: 10000, discountedPrice: 7000, discountRate: 30, moreCount: 1 });
    // 90분 뒤가 KST 자정을 넘으면 D-1이라 시각에 따라 둘 중 하나
    expect(["오늘 마감", "D-1"]).toContain(card.badge);
    expect(card.remainingSeconds).toBeGreaterThan(80 * 60);
    expect(card.remainingSeconds).toBeLessThanOrEqual(90 * 60);
    expect(card.remainingLabel).toBe("1시간 30분 남았어요");
  });

  it("다른 쇼핑몰 이벤트는 보이지 않고, 금액 할인도 계산한다. 내부 값은 내보내지 않는다", async () => {
    const s = await shop();
    const other = await shop();
    await db.product.create({ data: { sellerId: other.seller.id, name: "옆가게 상품", price: 10000, status: "ON_SALE", ...event(20, -1000, 3600_000) } });
    expect((await s.get()).eventCard).toBeNull();
    const p = await db.product.create({
      data: { sellerId: s.seller.id, name: "금액 할인", price: 10000, status: "ON_SALE", eventDiscountType: "AMOUNT", eventDiscountValue: 2500, eventStartsAt: at(-1000), eventEndsAt: at(3 * 24 * 3600_000) },
    });
    const body = await s.get();
    expect(body.eventCard).toMatchObject({ productName: "금액 할인", discountedPrice: 7500, discountRate: 25, moreCount: 0 });
    const raw = JSON.stringify(body.eventCard);
    for (const key of [p.id, "sellerId", "옆가게"]) expect(raw).not.toContain(key);
  });
});
