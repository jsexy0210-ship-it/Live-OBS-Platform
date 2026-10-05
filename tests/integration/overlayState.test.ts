import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as overlayState } from "../../app/api/overlay/[token]/state/route";
import { prisma } from "../../lib/server/db";
import { HALL_MAX, ORDER_EVENT_MAX } from "../../lib/server/overlay/state";
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
