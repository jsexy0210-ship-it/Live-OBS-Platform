import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { getBuyerOrder } from "../../lib/server/orders/buyer";
import { createOrder } from "../../lib/server/orders/create";
import { markOrderPaid } from "../../lib/server/queue/service";
import { createLoginBuyer, createSeller, db, resetDb } from "./helpers";

// SH-022 구매자 주문 상세 추가 값(MASTER 배정 2026-10-06): 품목별 사진·상품/옵션 id·대기열(순번·개봉 상태), 결제 수단(카드사·끝 4자리·할부), 현금영수증 신청, 받는 방법.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };

async function setup() {
  const { seller, grade } = await createSeller();
  const a = await createLoginBuyer(seller.id, grade.id);
  const b = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1개", stock: 50 } });
  await db.productImage.create({
    data: { sellerId: seller.id, productId: product.id, storageKey: `k-${product.id}`, contentType: "image/jpeg", byteSize: 10, width: 10, height: 10, sha256: "a".repeat(64), kind: "GALLERY" },
  });
  const order = async (buyerId: string, paid = true) => {
    const o = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyerId, items: [{ optionId: option.id, quantity: 2 }], consent, shippingAddress: addr });
    if (!o.ok) throw new Error(o.reason);
    if (paid) {
      const r = await markOrderPaid(db, { sellerId: seller.id, orderId: o.orderId, paymentMethod: "CARD" });
      if (!r.ok) throw new Error(r.reason);
    }
    return o.orderId;
  };
  return { seller, a, b, product, option, order };
}

describe("구매자 주문 상세 추가 값", () => {
  it("품목에 상품·옵션 id, 사진 주소, 대기열(순번·상태)이 붙고, 내 앞 대기 수만 센다(다른 구매자 정보 없음)", async () => {
    const s = await setup();
    const first = await s.order(s.a.id);
    const second = await s.order(s.b.id);
    const mine = await getBuyerOrder(db, { sellerId: s.seller.id, buyerMemberId: s.b.id }, second);
    expect(mine?.items).toHaveLength(1);
    const item = mine!.items[0];
    expect(item).toMatchObject({ productId: s.product.id, optionId: s.option.id, productNameSnapshot: "팩", quantity: 2 });
    expect(item.imageUrl).toMatch(new RegExp(`^/api/shop/${s.seller.slug}/`));
    // 두 번째 주문은 앞에 1건이 있어 대기 2번째
    expect(item.queue).toMatchObject({ status: "WAITING", waitingNumber: 2, openingStartedAt: null, doneAt: null, cancelledAt: null });
    expect((await getBuyerOrder(db, { sellerId: s.seller.id, buyerMemberId: s.a.id }, first))?.items[0].queue).toMatchObject({ status: "WAITING", waitingNumber: 1 });
    // 응답에 다른 구매자의 닉네임·주문 id가 없다
    const json = JSON.stringify(mine);
    expect(json).not.toContain(first);
    expect(json).not.toContain(s.a.id);
    // 개봉 중·완료로 바뀌면 순번은 없고 시각이 채워진다
    const q = await db.queueItem.findFirstOrThrow({ where: { orderId: second } });
    await db.queueItem.update({ where: { id: q.id }, data: { status: "DONE", openingStartedAt: new Date("2026-10-06T01:00:00Z"), doneAt: new Date("2026-10-06T01:05:00Z") } });
    const done = (await getBuyerOrder(db, { sellerId: s.seller.id, buyerMemberId: s.b.id }, second))!.items[0].queue;
    expect(done).toMatchObject({ status: "DONE", waitingNumber: null });
    expect(done?.openingStartedAt?.toISOString()).toBe("2026-10-06T01:00:00.000Z");
  });

  it("결제 수단: 카드사·끝 4자리·할부 개월만 주고(번호 전체·거래 번호 없음), 카드 결제가 없으면 card는 null. 받는 방법은 fulfillmentType", async () => {
    const s = await setup();
    const id = await s.order(s.a.id);
    expect((await getBuyerOrder(db, { sellerId: s.seller.id, buyerMemberId: s.a.id }, id))?.paymentInfo).toEqual({ method: "CARD", card: null });
    await db.payment.create({
      data: { sellerId: s.seller.id, orderId: id, provider: "nicepay", method: "CARD", status: "PAID", amount: 10000, pgTid: "tid-secret-1", cardName: "비씨", cardLast4: "1234", cardInstallment: 3, approvedAt: new Date() },
    });
    const d = await getBuyerOrder(db, { sellerId: s.seller.id, buyerMemberId: s.a.id }, id);
    expect(d?.paymentInfo).toEqual({ method: "CARD", card: { name: "비씨", last4: "1234", installment: 3 } });
    expect(d?.fulfillmentType).toBe("IMMEDIATE");
    expect(JSON.stringify(d)).not.toContain("tid-secret-1");
    await expect(db.payment.update({ where: { pgTid: "tid-secret-1" }, data: { cardLast4: "12345" } })).rejects.toThrow();
  });

  it("현금영수증 신청 여부: 신청(철회 전)이면 종류와 시각, 철회했거나 없으면 requested false. 신청 본인 확인 번호는 주지 않는다", async () => {
    const s = await setup();
    const id = await s.order(s.a.id);
    const scope = { sellerId: s.seller.id, buyerMemberId: s.a.id };
    expect((await getBuyerOrder(db, scope, id))?.cashReceipt).toEqual({ requested: false, kind: null, requestedAt: null });
    const r = await db.orderReceiptRequest.create({ data: { sellerId: s.seller.id, orderId: id, buyerMemberId: s.a.id, kind: "CASH_RECEIPT_INCOME", identitySealed: "x", identityLast4: "9876" } });
    expect((await getBuyerOrder(db, scope, id))?.cashReceipt).toMatchObject({ requested: true, kind: "CASH_RECEIPT_INCOME" });
    expect(JSON.stringify(await getBuyerOrder(db, scope, id))).not.toContain("9876");
    await db.orderReceiptRequest.update({ where: { id: r.id }, data: { withdrawnAt: new Date() } });
    expect((await getBuyerOrder(db, scope, id))?.cashReceipt.requested).toBe(false);
  });

  it("본인 주문만 조회된다(다른 구매자·다른 쇼핑몰은 null)", async () => {
    const s = await setup();
    const id = await s.order(s.a.id);
    expect(await getBuyerOrder(db, { sellerId: s.seller.id, buyerMemberId: s.b.id }, id)).toBeNull();
    const other = await createSeller();
    expect(await getBuyerOrder(db, { sellerId: other.seller.id, buyerMemberId: s.a.id }, id)).toBeNull();
  });
});
