import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createProduct, getProduct, listProducts, updateProduct } from "../../lib/server/products/manage";
import { prepareShipping } from "../../lib/server/orders/bulk";
import { markOrderPaid } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createBuyer(seller.id, grade.id);
  let orderNo = 0;
  // 상품 설정별로 품목 1개씩 가진 결제 대기 주문을 만든다.
  async function order(products: { queueEligible?: boolean; openTimerSeconds?: number | null }[]) {
    const o = await db.order.create({ data: { sellerId: seller.id, orderNo: ++orderNo, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 0 } });
    for (const p of products) {
      const product = await db.product.create({ data: { sellerId: seller.id, name: "팩", price: 5000, status: "ON_SALE", ...p } });
      const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock: 10 } });
      await db.orderItem.create({
        data: { sellerId: seller.id, orderId: o.id, productId: product.id, optionId: option.id, productNameSnapshot: "팩", optionNameSnapshot: "1팩", unitPrice: 5000, quantity: 1 },
      });
    }
    return o;
  }
  return { seller, ctx, order };
}

describe("상품 개봉 설정 저장·조회", () => {
  it("값을 주지 않으면 기본값(대기 등록, 타이머 기본)으로 만들어지고 조회에 나온다", async () => {
    const s = await shop();
    const r = await createProduct(db, s.ctx, { name: "기본", price: 1000 });
    expect(r).toMatchObject({ ok: true, value: { queueEligible: true, openTimerSeconds: null } });
    if (!r.ok) throw new Error();
    expect(await getProduct(db, s.ctx, r.value.id)).toMatchObject({ queueEligible: true, openTimerSeconds: null });
    const list = await listProducts(db, s.ctx);
    expect(list).toMatchObject({ ok: true, value: { products: [{ queueEligible: true, openTimerSeconds: null }] } });
  });

  it("등록·수정으로 제외 여부와 90/120초를 정하고, null로 기본으로 되돌린다", async () => {
    const s = await shop();
    const r = await createProduct(db, s.ctx, { name: "제외", price: 1000, queueEligible: false, openTimerSeconds: 90 });
    expect(r).toMatchObject({ ok: true, value: { queueEligible: false, openTimerSeconds: 90 } });
    if (!r.ok) throw new Error();
    expect(await updateProduct(db, s.ctx, r.value.id, { openTimerSeconds: 120 })).toMatchObject({ ok: true, value: { queueEligible: false, openTimerSeconds: 120 } });
    expect(await updateProduct(db, s.ctx, r.value.id, { queueEligible: true, openTimerSeconds: null })).toMatchObject({ ok: true, value: { queueEligible: true, openTimerSeconds: null } });
  });

  it("허용하지 않는 값은 거부하고 값을 바꾸지 않는다", async () => {
    const s = await shop();
    for (const body of [{ openTimerSeconds: 60 }, { openTimerSeconds: "90" }, { openTimerSeconds: 0 }, { queueEligible: "no" }, { queueEligible: null }]) {
      expect(await createProduct(db, s.ctx, { name: "x", price: 1000, ...body }), JSON.stringify(body)).toMatchObject({ ok: false });
    }
    const r = await createProduct(db, s.ctx, { name: "x", price: 1000, openTimerSeconds: 90 });
    if (!r.ok) throw new Error();
    for (const body of [{ openTimerSeconds: 60 }, { openTimerSeconds: 3.5 }, { queueEligible: 1 }]) {
      expect(await updateProduct(db, s.ctx, r.value.id, body), JSON.stringify(body)).toMatchObject({ ok: false });
    }
    expect(await getProduct(db, s.ctx, r.value.id)).toMatchObject({ queueEligible: true, openTimerSeconds: 90 });
  });

  it("DB도 90/120 외 값을 막는다", async () => {
    const s = await shop();
    await expect(db.product.create({ data: { sellerId: s.seller.id, name: "x", price: 1, openTimerSeconds: 60 } })).rejects.toThrow();
  });
});

describe("결제 완료 시 대기 등록 분기", () => {
  it("대기 제외 상품만 있는 주문은 대기 항목 없이 결제 완료된다", async () => {
    const s = await shop();
    const o = await s.order([{ queueEligible: false }]);
    const r = await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.id });
    expect(r).toMatchObject({ ok: true, value: { queueItemIds: [], stockShortage: false } });
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PAID");
    expect(await db.queueItem.count()).toBe(0);
  });

  it("섞인 주문은 대기 가능 상품만 등록하고 상품별 타이머를 쓴다(미설정은 기본 60초)", async () => {
    const s = await shop();
    const o = await s.order([{ queueEligible: false }, { openTimerSeconds: 120 }, {}]);
    const r = await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.id });
    expect(r.ok && r.value.queueItemIds.length).toBe(2);
    const timers = (await db.queueItem.findMany({ orderBy: { createdAt: "asc" } })).map((q) => q.timerSeconds).sort((a, b) => a - b);
    expect(timers).toEqual([60, 120]);
  });

  it("상품 90초 설정과 정책 기본값 변경이 반영된다", async () => {
    const s = await shop();
    await db.platformPolicy.upsert({ where: { key: "openTimerSeconds" }, update: { intValue: 75 }, create: { key: "openTimerSeconds", intValue: 75 } });
    const o = await s.order([{ openTimerSeconds: 90 }, {}]);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.id });
    const timers = (await db.queueItem.findMany()).map((q) => q.timerSeconds).sort((a, b) => a - b);
    expect(timers).toEqual([75, 90]);
  });

  it("대기 제외로 결제된 주문은 이후 상품을 대기 대상으로 되돌려도 배송 준비로 바꿀 수 있다", async () => {
    const s = await shop();
    const o = await s.order([{ queueEligible: false }, {}]);
    const items = await db.orderItem.findMany({ where: { orderId: o.id }, include: { product: true } });
    const freeItem = items.find((i) => !i.product.queueEligible)!;
    // 대기 가능 상품도 섞여 있으면 아직 개봉 전이라 막힌다
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.id });
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: freeItem.id } })).queueSkipped).toBe(true);
    expect(await db.orderItem.count({ where: { orderId: o.id, queueSkipped: true } })).toBe(1);

    const only = await s.order([{ queueEligible: false }]);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: only.id });
    await db.product.updateMany({ where: { sellerId: s.seller.id }, data: { queueEligible: true } });
    const r = await prepareShipping(db, s.ctx, [only.id, o.id]);
    if (!r.ok) throw new Error("bulk");
    expect(r.results).toEqual([
      { orderId: only.id, ok: true },
      { orderId: o.id, ok: false, reason: "not_opened" },
    ]);
  });
});
