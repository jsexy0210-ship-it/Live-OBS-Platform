import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as orderRoute } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES } from "../../lib/server/orders/messages";
import { markOrderPaid } from "../../lib/server/queue/service";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 50 } });
  const order = (orderNickname?: unknown) =>
    createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity: 1 }], consent, shippingAddress, orderNickname });
  return { seller, buyer, option, order };
}

const snapshotOf = async (orderId: string) => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).broadcastNicknameSnapshot;

describe("주문 닉네임", () => {
  it("넣으면 이 주문에만 쓰고(앞뒤 공백 제거), 회원 방송 닉네임은 바꾸지 않는다. 결제 뒤 주문대기 카드에도 주문 닉네임이 나온다", async () => {
    const s = await shop();
    const r = await s.order("  라이브왕 ");
    if (!r.ok) throw new Error(r.reason);
    expect(await snapshotOf(r.orderId)).toBe("라이브왕");
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).broadcastNickname).toBe(s.buyer.broadcastNickname);
    const paid = await markOrderPaid(db, { sellerId: s.seller.id, orderId: r.orderId, paymentMethod: "CARD" });
    expect(paid.ok).toBe(true);
    expect((await db.queueItem.findFirstOrThrow({ where: { orderId: r.orderId } })).nicknameSnapshot).toBe("라이브왕");
  });

  it("없거나 비우면(공백만 포함) 회원 방송 닉네임", async () => {
    const s = await shop();
    for (const v of [undefined, null, "", "   "]) {
      const r = await s.order(v);
      if (!r.ok) throw new Error(r.reason);
      expect(await snapshotOf(r.orderId), String(v)).toBe(s.buyer.broadcastNickname);
    }
  });

  it("20자를 넘거나 제어문자·문자열이 아닌 값이면 주문을 만들지 않는다(invalid_order_nickname)", async () => {
    const s = await shop();
    expect(await s.order("가".repeat(20))).toMatchObject({ ok: true });
    for (const v of ["가".repeat(21), "닉\u0000네임", "닉\n네임", 123, { a: 1 }]) {
      expect(await s.order(v), JSON.stringify(v)).toEqual({ ok: false, reason: "invalid_order_nickname" });
    }
    expect(await db.order.count()).toBe(1);
  });

  it("주문 API가 orderNickname을 넘기고, 틀리면 400과 해요체 문구", async () => {
    const s = await shop();
    const login = await loginBuyer(db, { sellerId: s.seller.id, loginId: s.buyer.loginId, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const post = (body: Record<string, unknown>) =>
      orderRoute(
        new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", cookie: `lo_buyer=${login.token}` },
          body: JSON.stringify({ items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress, ...body }),
        }),
        { params: Promise.resolve({ slug: s.seller.slug }) },
      );
    const ok = await post({ orderNickname: "방송닉" });
    expect(ok.status).toBe(200);
    expect(await snapshotOf((await ok.json()).orderId)).toBe("방송닉");
    const bad = await post({ orderNickname: "가".repeat(21) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_order_nickname", message: ORDER_ERROR_MESSAGES.invalid_order_nickname });
  });
});
