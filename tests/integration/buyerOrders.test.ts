import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as consentRoute } from "../../app/api/shop/[slug]/order-consent/route";
import { GET as detailRoute } from "../../app/api/shop/[slug]/orders/[orderId]/route";
import { GET as listRoute, POST as orderRoute } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { shipOrder } from "../../lib/server/orders/ship";
import { markOrderPaid } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1", memo: "문 앞" };

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", priceDelta: 1000, stock: 50 } });
  const a = await createLoginBuyer(seller.id, grade.id);
  const b = await createLoginBuyer(seller.id, grade.id);
  const order = async (buyerId: string, quantity = 1) => {
    const r = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyerId, items: [{ optionId: option.id, quantity }], consent, shippingAddress: addr });
    if (!r.ok) throw new Error(r.reason);
    return r.orderId;
  };
  return { seller, ctx, product, option, a, b, order };
}

async function cookie(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

const list = (slug: string, c?: string, qs = "") =>
  listRoute(new Request(`http://localhost:3000/api/shop/${slug}/orders${qs}`, { headers: { ...H, ...(c ? { cookie: c } : {}) } }), { params: Promise.resolve({ slug }) });
const detail = (slug: string, orderId: string, c?: string) =>
  detailRoute(new Request(`http://localhost:3000/api/shop/${slug}/orders/${orderId}`, { headers: { ...H, ...(c ? { cookie: c } : {}) } }), {
    params: Promise.resolve({ slug, orderId }),
  });

describe("구매자 주문 조회", () => {
  it("목록은 본인 주문만 최근순으로, 품목 스냅숏·금액·배송비·배송 상태·송장을 주고 배송지·내부 값은 주지 않는다", async () => {
    const s = await shop();
    const first = await s.order(s.a.id, 2);
    const second = await s.order(s.a.id);
    await s.order(s.b.id);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: first, paymentMethod: "CARD" });
    await shipOrder(db, s.ctx, first, { courier: "CJ", trackingNumber: "123456789012" });

    const res = await list(s.seller.slug, await cookie(s.seller.id, s.a.loginId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual([second, first]);
    expect(body.orders[1]).toMatchObject({
      status: "PAID",
      totalAmount: 15000,
      shippingFee: 3000,
      items: [{ productNameSnapshot: "부스터 팩", optionNameSnapshot: "1박스", unitPrice: 6000, quantity: 2 }],
      shipment: { courier: "CJ", courierName: "CJ대한통운", trackingNumber: "123456789012", status: "IN_TRANSIT" },
    });
    expect(body.orders[0]).toMatchObject({ status: "PENDING_PAYMENT", shipment: null });
    for (const key of ["shippingAddress", "sellerId", "buyerMemberId", "pgTxId", "pgProvider", "stockShortageAt", "broadcastNicknameSnapshot"]) {
      expect(body.orders[1], key).not.toHaveProperty(key);
    }
  });

  it("상세는 본인 주문에만 배송지를 주고, 다른 구매자 주문·다른 쇼핑몰 주문·없는 주문은 404", async () => {
    const s = await shop();
    const other = await shop();
    const mine = await s.order(s.a.id);
    const bOrder = await s.order(s.b.id);
    const otherShopOrder = await other.order(other.a.id);
    const ca = await cookie(s.seller.id, s.a.loginId);

    const ok = await detail(s.seller.slug, mine, ca);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ id: mine, shippingFee: 3000, shippingAddress: { recipientName: "김구매", phone: "01012345678", address1: "서울 강남구 테헤란로 1", memo: "문 앞" } });
    expect(body).not.toHaveProperty("sellerId");
    expect(body).not.toHaveProperty("buyerMemberId");

    expect((await detail(s.seller.slug, bOrder, ca)).status).toBe(404);
    expect((await detail(s.seller.slug, otherShopOrder, ca)).status).toBe(404);
    // 다른 쇼핑몰 주소로 들어오면 그 쇼핑몰 세션이 아니라 401, 다른 쇼핑몰 구매자가 이 주문 id를 넣으면 404
    expect((await detail(other.seller.slug, mine, ca)).status).toBe(401);
    expect((await detail(other.seller.slug, mine, await cookie(other.seller.id, other.a.loginId))).status).toBe(404);
    expect((await detail(s.seller.slug, "00000000-0000-0000-0000-000000000000", ca)).status).toBe(404);
    expect((await detail(s.seller.slug, "not-a-uuid", ca)).status).toBe(404);
  });

  it("주문 뒤 상품 이름·가격이 바뀌어도 주문 당시 스냅숏을 보여 준다", async () => {
    const s = await shop();
    const id = await s.order(s.a.id);
    await db.product.update({ where: { id: s.product.id }, data: { name: "새 이름", price: 9999 } });
    const body = await (await detail(s.seller.slug, id, await cookie(s.seller.id, s.a.loginId))).json();
    expect(body.items).toEqual([{ productNameSnapshot: "부스터 팩", optionNameSnapshot: "1박스", unitPrice: 6000, quantity: 1 }]);
  });

  it("잠긴 쇼핑몰이어도 기존 주문 목록·상세는 열리고, 새 주문만 402", async () => {
    const s = await shop();
    const id = await s.order(s.a.id);
    const ca = await cookie(s.seller.id, s.a.loginId);
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    expect((await list(s.seller.slug, ca)).status).toBe(200);
    expect((await detail(s.seller.slug, id, ca)).status).toBe(200);
    const res = await orderRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, {
        method: "POST",
        headers: { ...H, cookie: ca },
        body: JSON.stringify({ items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress: addr }),
      }),
      { params: Promise.resolve({ slug: s.seller.slug }) },
    );
    expect(res.status).toBe(402);
  });

  it("로그인 안 함은 401, 없는 쇼핑몰은 404", async () => {
    const s = await shop();
    expect((await list(s.seller.slug)).status).toBe(401);
    expect((await detail(s.seller.slug, "00000000-0000-0000-0000-000000000000")).status).toBe(401);
    expect((await list("no-such-shop", await cookie(s.seller.id, s.a.loginId))).status).toBe(404);
  });

  it("목록 커서: 끝까지 넘기면 빠짐·겹침 없이 모두 나오고, 다른 구매자 주문 커서·잘못된 limit은 400", async () => {
    const s = await shop();
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) mine.push(await s.order(s.a.id));
    const bOrder = await s.order(s.b.id);
    const ca = await cookie(s.seller.id, s.a.loginId);
    const seen: string[] = [];
    let qs = "?limit=2";
    for (let round = 0; round < 10; round++) {
      const body = await (await list(s.seller.slug, ca, qs)).json();
      seen.push(...body.orders.map((o: { id: string }) => o.id));
      if (!body.nextCursor) break;
      qs = `?limit=2&cursor=${body.nextCursor}`;
    }
    // 같은 밀리초에 만들어진 주문도 있을 수 있어 DB 정렬(createdAt 내림 → id 내림)과 비교한다
    const expected = (await db.order.findMany({ where: { buyerMemberId: s.a.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } })).map((o) => o.id);
    expect(new Set(expected)).toEqual(new Set(mine));
    expect(seen).toEqual(expected);
    const badCursor = await list(s.seller.slug, ca, `?cursor=${bOrder}`);
    expect(badCursor.status).toBe(400);
    expect((await badCursor.json()).error).toBe("invalid_cursor");
    for (const limit of ["0", "51", "1e2", "abc"]) {
      const r = await list(s.seller.slug, ca, `?limit=${limit}`);
      expect(r.status, limit).toBe(400);
      expect((await r.json()).error).toBe("invalid_limit");
    }
  });
});

describe("결제 전 동의 문구 API", () => {
  it("지금 문구·버전을 내려주고, 그 버전으로 주문하면 만들어지며, 없는 쇼핑몰은 404", async () => {
    const s = await shop();
    const res = await consentRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/order-consent`), { params: Promise.resolve({ slug: s.seller.slug }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ consents: [{ kind: "OPENED_NO_REFUND", version: OPENED_NO_REFUND_CONSENT.version, text: "개봉하면 취소·환불이 안 돼요" }] });
    const r = await createOrder(db, {
      sellerId: s.seller.id,
      buyerMemberId: s.a.id,
      items: [{ optionId: s.option.id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: body.consents[0].version },
      shippingAddress: addr,
    });
    expect(r).toMatchObject({ ok: true });
    expect((await consentRoute(new Request("http://localhost:3000/api/shop/none/order-consent"), { params: Promise.resolve({ slug: "none" }) })).status).toBe(404);
  });
});
