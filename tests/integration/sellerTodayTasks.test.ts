import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as route } from "../../app/api/seller/today-tasks/route";
import { createSellerSession } from "../../lib/server/auth/session";
import { listSellerInquiries } from "../../lib/server/buyer-inquiries/service";
import { listSellerOrders } from "../../lib/server/orders/read";
import { listPendingDeposits } from "../../lib/server/payments/bank";
import { listProducts } from "../../lib/server/products/manage";
import { listSellerReturns } from "../../lib/server/shop-returns/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 파트너스 홈 「오늘 처리할 일」 GET /api/seller/today-tasks (SA-002)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

type Shop = Awaited<ReturnType<typeof createSeller>>;
const cookieOf = async (s: Shop, user: Awaited<ReturnType<typeof createSellerUser>>) =>
  `lo_seller=${(await createSellerSession(db, s.seller.id, user.id, {}, user.credentialVersion)).token}`;
const get = (cookie?: string) => route(new Request("http://localhost:3000/api/seller/today-tasks", { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } }));
const counts = (body: { items: { key: string; count: number }[] }) => Object.fromEntries(body.items.map((i) => [i.key, i.count]));

// 입금 대기 2(법정 보관 1은 제외)·배송 준비 6(결제 완료 + 배송 정보 없음. 배송 정보 있는 1건 제외)·반품 요청 2(철회된 1은 제외)·문의 대기 2·재고 없음 2·재고 적음 1
async function seed(s: Shop) {
  const buyer = await createBuyer(s.seller.id, s.grade.id);
  const sellerId = s.seller.id;
  const order = (extra: Record<string, unknown>) =>
    db.order.create({ data: { sellerId, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 5000, status: "PENDING_PAYMENT", ...extra } as never });
  await order({});
  await order({});
  await order({ legalHoldAt: new Date() });
  await order({ status: "PAID", paidAt: new Date() }); // 배송 준비
  await order({ status: "PAID", paidAt: new Date() }); // 배송 준비
  await order({ status: "PAID", paidAt: new Date(), fulfillmentType: "STORAGE" });
  const shipped = await order({ status: "PAID", paidAt: new Date() });
  await db.shipment.create({ data: { sellerId, orderId: shipped.id, courier: "CJ", trackingNumber: "1", shippedAt: new Date() } });
  for (const [status, extra] of [["REQUESTED", {}], ["REQUESTED", {}], ["CANCELLED", { cancelledAt: new Date() }]] as const) {
    const o = await order({ status: "PAID", paidAt: new Date(), fulfillmentType: "STORAGE" });
    await db.returnRequest.create({ data: { sellerId, orderId: o.id, buyerMemberId: buyer.id, kind: "RETURN", reason: "DEFECTIVE", status, ...extra } });
  }
  const inq = (status: "WAITING" | "ANSWERED") =>
    db.buyerInquiry.create({ data: { sellerId, buyerMemberId: buyer.id, kind: "GENERAL", authorNickname: "닉", title: "문의", body: "내용", status, ...(status === "ANSWERED" ? { answer: "답변", answeredAt: new Date() } : {}) } as never });
  await inq("WAITING");
  await inq("WAITING");
  await inq("ANSWERED");
  const product = async (status: "ON_SALE" | "SOLD_OUT" | "DRAFT", stocks: number[], extra: Record<string, unknown> = {}) => {
    const p = await db.product.create({ data: { sellerId, name: "상품", price: 1000, status, ...extra } });
    for (const stock of stocks) await db.productOption.create({ data: { sellerId, productId: p.id, name: "옵션", stock } });
    return p;
  };
  await product("ON_SALE", [0]); // 재고 없음
  await product("SOLD_OUT", [0, 0]); // 재고 없음
  const low = await product("ON_SALE", [2, 1]); // 재고 적음(합 3), 지운 옵션은 안 더함
  await db.productOption.create({ data: { sellerId, productId: low.id, name: "지움", stock: 100, deletedAt: new Date() } });
  await product("ON_SALE", [6]); // 충분
  await product("DRAFT", [0]); // 판매 대기는 뺌
  await product("ON_SALE", [0], { deletedAt: new Date() }); // 지운 상품은 뺌
}

describe("파트너스 오늘 처리할 일", () => {
  it("대표자는 항목별 건수와 처리 화면 주소를 받고, 다른 쇼핑몰·상태는 섞이지 않는다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    await seed(a);
    await seed(b);
    await db.order.create({ data: { sellerId: b.seller.id, orderNo: 7, buyerMemberId: (await createBuyer(b.seller.id, b.grade.id)).id, broadcastNicknameSnapshot: "닉", totalAmount: 1, status: "PENDING_PAYMENT" } });
    const owner = await createSellerUser(a.seller.id, "OWNER");
    const res = await get(await cookieOf(a, owner));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(counts(body)).toEqual({ depositPending: 2, shipPending: 6, returnRequested: 2, inquiryWaiting: 2, stockOut: 2, stockLow: 1 });
    expect(body.total).toBe(15);
    expect(body.items.map((i: { key: string }) => i.key)).toEqual(["depositPending", "shipPending", "returnRequested", "inquiryWaiting", "stockOut", "stockLow"]);
    expect(Object.fromEntries(body.items.map((i: { key: string; href: string }) => [i.key, i.href]))).toEqual({
      depositPending: "/seller/orders/deposits",
      shipPending: "/seller/orders?status=PAID&shipped=false",
      returnRequested: "/seller/returns?status=REQUESTED",
      inquiryWaiting: "/seller/buyer-inquiries?status=WAITING",
      stockOut: "/seller/products?stock=out&display=shown",
      stockLow: "/seller/products?stock=low&display=shown",
    });
    // 숫자와 주소만(구매자 정보 키 없음)
    expect(Object.keys(body).sort()).toEqual(["items", "total"]);
    for (const i of body.items) expect(Object.keys(i).sort()).toEqual(["count", "href", "key"]);
    expect(JSON.stringify(body)).not.toMatch(/구매자\d|010\d{8}|닉네임/);
  });

  it("홈 숫자는 href로 연 목록의 전체 행 수와 같다(주문·입금·반품·문의·상품 목록 함수와 맞춰 본다)", async () => {
    const a = await createSeller();
    await seed(a);
    const owner = await createSellerUser(a.seller.id, "OWNER");
    const ctx: TenantContext = { sellerId: a.seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
    const body = await (await get(await cookieOf(a, owner))).json();
    const n = Object.fromEntries(body.items.map((i: { key: string; count: number }) => [i.key, i.count]));

    const ship = await listSellerOrders(db, ctx, { status: ["PAID"], shipped: "false", limit: "200" });
    if (!ship.ok) throw new Error("orders");
    expect(n.shipPending).toBe(ship.orders.length);
    const deposits = await listPendingDeposits(db, ctx, {});
    if (!deposits.ok) throw new Error("deposits");
    expect(n.depositPending).toBe(deposits.value.total);
    const returns = await listSellerReturns(db, ctx, { status: "REQUESTED" });
    expect(n.returnRequested).toBe(returns.returns.length);
    const inquiries = await listSellerInquiries(db, ctx, { status: "WAITING" }, "");
    if (!inquiries.ok) throw new Error("inquiries");
    expect(n.inquiryWaiting).toBe(inquiries.value.inquiries.length);
    for (const [key, stock] of [["stockOut", "out"], ["stockLow", "low"]] as const) {
      const r = await listProducts(db, ctx, { stock, display: "shown", limit: 200 });
      if (!r.ok) throw new Error("products");
      expect(n[key], key).toBe(r.value.products.length);
    }
  });

  it("직원은 읽을 수 있는 항목만 받는다(권한 없는 항목은 빠지고 403이 아니다)", async () => {
    const s = await createSeller();
    await seed(s);
    const inquiryOnly = await createSellerUser(s.seller.id, { permissions: ["INQUIRY_REPLY"] });
    expect(counts(await (await get(await cookieOf(s, inquiryOnly))).json())).toEqual({ inquiryWaiting: 2 });
    const orderOnly = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    expect(counts(await (await get(await cookieOf(s, orderOnly))).json())).toEqual({ depositPending: 2, shipPending: 6, returnRequested: 2 });
    const productOnly = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    expect(counts(await (await get(await cookieOf(s, productOnly))).json())).toEqual({ stockOut: 2, stockLow: 1 });
    const none = await createSellerUser(s.seller.id, { permissions: ["BROADCAST_RUN"] });
    const r = await (await get(await cookieOf(s, none))).json();
    expect(r).toEqual({ total: 0, items: [] });
  });

  it("로그인 없음은 401, 읽기만 하며 아무것도 바꾸지 않는다", async () => {
    const s = await createSeller();
    await seed(s);
    const owner = await createSellerUser(s.seller.id, "OWNER");
    expect((await get()).status).toBe(401);
    const before = [await db.order.count(), await db.returnRequest.count(), await db.buyerInquiry.count(), await db.productOption.count(), await db.auditLog.count()];
    await get(await cookieOf(s, owner));
    expect([await db.order.count(), await db.returnRequest.count(), await db.buyerInquiry.count(), await db.productOption.count(), await db.auditLog.count()]).toEqual(before);
  });
});
