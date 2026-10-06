import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as broadcastStart } from "../../app/api/seller/broadcast/start/route";
import { PUT as profilePut } from "../../app/api/seller/shop-profile/route";
import { GET as buyerOrdersGet } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { shopOpen } from "../../lib/server/buyers/signup";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { shopOpenForPayment } from "../../lib/server/payments/service";
import { shopShareMeta } from "../../lib/server/shop/sharePreview";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 쇼핑몰 운영 상태(SA-060): 준비 중·일시 정지면 새 주문·결제·가입 등 쓰기와 공개 콘텐츠는 막고, 본인 주문 조회·파트너스 쪽 처리는 그대로다.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };

async function shop() {
  const plans = await seedPlans();
  const { seller, grade } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { planId: plans.INTEGRATED.id } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
  if (!login.ok) throw new Error(login.reason);
  const cookie = `lo_seller=${login.token}`;
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 10 } });
  const place = (buyerMemberId: string) =>
    createOrder(db, {
      sellerId: seller.id,
      buyerMemberId,
      items: [{ optionId: option.id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version },
      shippingAddress: { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" },
    });
  const setState = (operatingState: string) =>
    profilePut(new Request("http://localhost:3000/api/seller/shop-profile", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify({ operatingState }) }));
  return { seller, grade, cookie, setState, place };
}

describe("쇼핑몰 운영 상태", () => {
  it.each(["PREPARING", "PAUSED"])("%s: 새 주문·결제·공유 미리보기가 막히고, OPEN으로 되돌리면 다시 열린다", async (state) => {
    const s = await shop();
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    expect(await shopOpen(db, s.seller.id)).toBe(true);
    expect(await shopOpenForPayment(db, s.seller.id)).toBe(true);
    expect((await s.setState(state)).status).toBe(200);
    expect(await shopOpen(db, s.seller.id)).toBe(false);
    expect(await shopOpenForPayment(db, s.seller.id)).toBe(false);
    expect(await s.place(buyer.id)).toEqual({ ok: false, reason: "shop_unavailable" });
    expect(await db.order.count()).toBe(0);
    expect(await shopShareMeta(db, s.seller.slug)).toBeNull();
    expect((await s.setState("OPEN")).status).toBe(200);
    expect(await shopOpen(db, s.seller.id)).toBe(true);
    expect(await shopOpenForPayment(db, s.seller.id)).toBe(true);
    expect((await s.place(buyer.id)).ok).toBe(true);
  });

  it("준비 중이어도 구매자 본인 주문 조회와 파트너스 방송 시작은 된다(다른 쇼핑몰은 영향 없음)", async () => {
    const s = await shop();
    const other = await shop();
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    const login = await loginBuyer(db, { sellerId: s.seller.id, loginId: buyer.loginId, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    await s.setState("PREPARING");
    const orders = await buyerOrdersGet(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, { headers: { ...H, cookie: `lo_buyer=${login.token}` } }), {
      params: Promise.resolve({ slug: s.seller.slug }),
    });
    expect(orders.status).toBe(200);
    const started = await broadcastStart(new Request("http://localhost:3000/api/seller/broadcast/start", { method: "POST", headers: { ...H, cookie: s.cookie }, body: JSON.stringify({ title: "방송" }) }));
    expect(started.status).toBe(200);
    expect(await shopOpen(db, other.seller.id)).toBe(true);
  });
});
