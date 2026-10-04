import type { OrderStatus, PaymentMethod } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as ordersRoute } from "../../app/api/seller/stats/orders/route";
import { GET as salesRoute } from "../../app/api/seller/stats/sales/route";
import { GET as productsRoute } from "../../app/api/seller/stats/products/route";
import { GET as membersRoute } from "../../app/api/seller/stats/members/route";
import { GET as broadcastsRoute } from "../../app/api/seller/stats/broadcasts/route";
import { loginSeller } from "../../lib/server/auth/login";
import { broadcastStats } from "../../lib/server/stats/broadcasts";
import { memberStats } from "../../lib/server/stats/members";
import { orderStats } from "../../lib/server/stats/orders";
import { productStats } from "../../lib/server/stats/products";
import { parseStatsRange } from "../../lib/server/stats/range";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000" };

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

type OrderInput = {
  createdAt: string;
  status?: OrderStatus;
  total?: number;
  shippingFee?: number;
  refundAmount?: number | null;
  method?: PaymentMethod | null;
  // 품목: [정가, 판매 단가, 수량, 상품 id(없으면 기본 상품)]
  items?: [number | null, number, number, string?][];
  buyerId?: string;
};

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const buyer = await createBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock: 100 } });
  let n = 0;
  const order = async (o: OrderInput) => {
    const status = o.status ?? "PAID";
    const paid = status === "PAID" || status === "REFUNDED";
    const created = await db.order.create({
      data: {
        sellerId: seller.id,
        orderNo: ++n,
        buyerMemberId: o.buyerId ?? buyer.id,
        broadcastNicknameSnapshot: "닉",
        status,
        totalAmount: o.total ?? 10000,
        shippingFee: o.shippingFee ?? 0,
        createdAt: new Date(o.createdAt),
        paidAt: paid ? new Date(o.createdAt) : null,
        paymentMethod: paid ? (o.method === undefined ? "CARD" : o.method) : null,
        refundAmount: status === "REFUNDED" ? (o.refundAmount ?? null) : null,
        refundedAt: status === "REFUNDED" ? new Date(o.createdAt) : null,
        cancelledAt: status === "CANCELLED" ? new Date(o.createdAt) : null,
      },
    });
    const items = [];
    for (const [list, unit, qty, productId] of o.items ?? []) {
      const pid = productId ?? product.id;
      const opt = pid === product.id ? option : await db.productOption.findFirstOrThrow({ where: { productId: pid } });
      items.push(await db.orderItem.create({
        data: {
          sellerId: seller.id,
          orderId: created.id,
          productId: pid,
          optionId: opt.id,
          productNameSnapshot: "스냅숏",
          optionNameSnapshot: opt.name,
          unitPrice: unit,
          listUnitPrice: list,
          quantity: qty,
        },
      }));
    }
    return { ...created, items };
  };
  const newProduct = async (name: string, status: "ON_SALE" | "DRAFT" | "HIDDEN" | "SOLD_OUT" = "ON_SALE", deleted = false) => {
    const p = await db.product.create({ data: { sellerId: seller.id, name, price: 1000, status, deletedAt: deleted ? new Date() : null } });
    await db.productOption.create({ data: { sellerId: seller.id, productId: p.id, name: "기본", stock: 100 } });
    return p;
  };
  const newBuyer = (createdAt?: string) =>
    createBuyer(seller.id, grade.id).then((b) => (createdAt ? db.buyerMember.update({ where: { id: b.id }, data: { createdAt: new Date(createdAt) } }) : b));
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, buyer, product, order, ctx, newProduct, newBuyer };
}

async function call(route: (req: Request) => Promise<Response>, path: string, cookie?: string) {
  const r = await route(new Request(`http://localhost:3000/api/seller/stats/${path}`, { headers: { ...H, ...(cookie ? { cookie } : {}) } }));
  return { status: r.status, body: await r.json() };
}

describe("통계 기간 해석", () => {
  it("KST 날짜를 [0시, 다음날 0시)로 바꾸고 바로 앞 같은 일수를 비교 기간으로 둔다", () => {
    const r = parseStatsRange({ from: "2026-10-01", to: "2026-10-07" })!;
    expect(r.start.toISOString()).toBe("2026-09-30T15:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(r.days).toBe(7);
    expect(r.prev).toMatchObject({ from: "2026-09-24", to: "2026-09-30" });
    expect(r.prev.start.toISOString()).toBe("2026-09-23T15:00:00.000Z");
    expect(r.unit).toBe("day");
  });

  it("끝이 시작보다 앞이거나, 없는 날짜·형식이거나, 366일을 넘거나, 단위가 틀리면 거부한다", () => {
    expect(parseStatsRange({ from: "2026-10-07", to: "2026-10-01" })).toBeNull();
    expect(parseStatsRange({ from: "2026-02-30", to: "2026-03-01" })).toBeNull();
    expect(parseStatsRange({ from: "2026/10/01", to: "2026-10-01" })).toBeNull();
    expect(parseStatsRange({ from: "2025-01-01", to: "2026-01-02" })).toBeNull();
    expect(parseStatsRange({ from: "2025-01-01", to: "2026-01-01" })).not.toBeNull();
    expect(parseStatsRange({ from: "2026-10-01", to: "2026-10-01", unit: "year" })).toBeNull();
    expect(parseStatsRange({ from: null, to: "2026-10-01" })).toBeNull();
  });
});

describe("주문 통계 GET /api/seller/stats/orders", () => {
  it("KST 날짜 경계: 9/30 23:59:59.999 KST 주문은 빼고 10/1 0시 주문부터, 10/7 23:59:59.999까지 센다", async () => {
    const s = await shop();
    await s.order({ createdAt: "2026-09-30T14:59:59.999Z" }); // 9/30 23:59:59.999 KST
    await s.order({ createdAt: "2026-09-30T15:00:00.000Z" }); // 10/1 00:00 KST
    await s.order({ createdAt: "2026-10-07T14:59:59.999Z" }); // 10/7 23:59:59.999 KST
    await s.order({ createdAt: "2026-10-07T15:00:00.000Z" }); // 10/8 00:00 KST
    const r = await orderStats(db, s.ctx, parseStatsRange({ from: "2026-10-01", to: "2026-10-07" })!);
    expect(r.current.orders).toBe(2);
    expect(r.previous.orders).toBe(1);
    expect(r.series).toHaveLength(7);
    expect(r.series[0]).toMatchObject({ bucket: "2026-10-01", orders: 1 });
    expect(r.series[6]).toMatchObject({ bucket: "2026-10-07", orders: 1 });
    expect(r.series.slice(1, 6).every((p) => p.orders === 0 && p.revenue === 0)).toBe(true);
  });

  it("결제 대기·결제 완료·취소·환불을 나눠 세고, 결제액·객단가·취소율·환불율·순매출을 계산한다", async () => {
    const s = await shop();
    const at = "2026-10-02T03:00:00Z";
    await s.order({ createdAt: at, status: "PENDING_PAYMENT", total: 99999 });
    await s.order({ createdAt: at, status: "PAID", total: 10000 });
    await s.order({ createdAt: at, status: "PAID", total: 20000 });
    await s.order({ createdAt: at, status: "CANCELLED", total: 50000 });
    await s.order({ createdAt: at, status: "REFUNDED", total: 15000, refundAmount: 12000 });
    // 환불액 기록이 없던 옛 환불 주문은 결제액 전부를 환불액으로 본다
    await s.order({ createdAt: at, status: "REFUNDED", total: 5000, refundAmount: null });
    const { body, status } = await call(ordersRoute, "orders?from=2026-10-01&to=2026-10-07", await cookieOf(s.owner.email));
    expect(status).toBe(200);
    expect(body.current).toEqual({
      orders: 6,
      paidOrders: 4,
      revenue: 50000,
      averageOrderValue: 12500,
      cancelled: 1,
      cancelRate: 0.1667,
      refunded: 2,
      refundRate: 0.5,
      refundAmount: 17000,
      netRevenue: 33000,
    });
    expect(body.previous).toMatchObject({ orders: 0, averageOrderValue: null, cancelRate: null, refundRate: null });
    expect(body.range).toEqual({ from: "2026-10-01", to: "2026-10-07", unit: "day", previous: { from: "2026-09-24", to: "2026-09-30" } });
  });

  it("주 단위는 월요일, 월 단위는 1일로 묶는다(KST)", async () => {
    const s = await shop();
    await s.order({ createdAt: "2026-09-27T15:30:00Z" }); // 9/28(월) KST
    await s.order({ createdAt: "2026-10-04T14:00:00Z" }); // 10/4(일) 23시 KST → 9/28 주
    await s.order({ createdAt: "2026-10-04T15:00:00Z" }); // 10/5(월) 0시 KST → 10/5 주
    const week = await orderStats(db, s.ctx, parseStatsRange({ from: "2026-09-28", to: "2026-10-11", unit: "week" })!);
    expect(week.series.map((p) => [p.bucket, p.orders])).toEqual([
      ["2026-09-28", 2],
      ["2026-10-05", 1],
    ]);
    const month = await orderStats(db, s.ctx, parseStatsRange({ from: "2026-09-15", to: "2026-10-31", unit: "month" })!);
    expect(month.series.map((p) => [p.bucket, p.orders])).toEqual([
      ["2026-09-01", 1],
      ["2026-10-01", 2],
    ]);
  });

  it("다른 쇼핑몰 주문은 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await a.order({ createdAt: "2026-10-02T03:00:00Z", total: 10000 });
    await b.order({ createdAt: "2026-10-02T03:00:00Z", total: 70000 });
    await b.order({ createdAt: "2026-10-02T03:00:00Z", status: "CANCELLED" });
    const r = await call(ordersRoute, "orders?from=2026-10-01&to=2026-10-07", await cookieOf(a.owner.email));
    expect(r.body.current).toMatchObject({ orders: 1, revenue: 10000, cancelled: 0 });
    const sales = await call(salesRoute, "sales?from=2026-10-01&to=2026-10-07", await cookieOf(a.owner.email));
    expect(sales.body.current).toMatchObject({ paid: 10000, paidOrders: 1 });
  });

  it("권한: 로그인 없음 401, 통계 권한 없는 직원 403, 통계 권한 직원 200, 오버레이 전용 플랜 403, 잘못된 기간 400", async () => {
    const s = await shop();
    const q = "orders?from=2026-10-01&to=2026-10-07";
    expect((await call(ordersRoute, q)).status).toBe(401);
    const noStats = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING", "PRODUCT_MANAGE"] });
    expect(await call(ordersRoute, q, await cookieOf(noStats.email))).toEqual({ status: 403, body: { error: "forbidden" } });
    expect((await call(salesRoute, q.replace("orders", "sales"), await cookieOf(noStats.email))).status).toBe(403);
    const stats = await createSellerUser(s.seller.id, { permissions: ["SALES_VIEW"] });
    expect((await call(ordersRoute, q, await cookieOf(stats.email))).status).toBe(200);
    expect((await call(salesRoute, q.replace("orders", "sales"), await cookieOf(stats.email))).status).toBe(200);
    expect((await call(ordersRoute, "orders?from=2025-01-01&to=2026-10-01", await cookieOf(stats.email))).body).toEqual({ error: "bad_range" });

    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    await db.sellerSubscription.create({ data: { sellerId: s.seller.id, planId: plan.id, status: "ACTIVE" } });
    expect(await call(ordersRoute, q, await cookieOf(s.owner.email))).toEqual({ status: 403, body: { error: "plan_feature_required" } });
  });

  it("마스터 대리 조회(읽기 전용)는 통계를 볼 수 있다", async () => {
    const s = await shop();
    await s.order({ createdAt: "2026-10-02T03:00:00Z" });
    const ro: TenantContext = { sellerId: s.seller.id, actorType: "PLATFORM_ADMIN", actorId: s.owner.id, isOwner: false, permissions: [], readOnly: true };
    expect((await orderStats(db, ro, parseStatsRange({ from: "2026-10-01", to: "2026-10-07" })!)).current.orders).toBe(1);
  });
});

describe("매출 통계 GET /api/seller/stats/sales", () => {
  it("판매액(정가)·할인·배송비·결제액·환불액·순매출과 결제 수단별을 계산하고, 결제 대기·취소 주문은 넣지 않는다", async () => {
    const s = await shop();
    const at = "2026-10-03T03:00:00Z";
    // 이벤트 할인: 정가 6000 → 5000 × 2개, 배송비 3000
    await s.order({ createdAt: at, total: 13000, shippingFee: 3000, method: "CARD", items: [[6000, 5000, 2]] });
    // 정가 기록이 없던 옛 품목은 판매 단가를 정가로 본다
    await s.order({ createdAt: at, total: 8000, method: "BANK_TRANSFER", items: [[null, 4000, 2]] });
    await s.order({ createdAt: at, status: "REFUNDED", total: 7000, refundAmount: 4000, method: "CARD", items: [[7000, 7000, 1]] });
    await s.order({ createdAt: at, total: 1000, method: null, items: [[1000, 1000, 1]] });
    await s.order({ createdAt: at, status: "PENDING_PAYMENT", total: 90000, items: [[90000, 90000, 1]] });
    await s.order({ createdAt: at, status: "CANCELLED", total: 90000, items: [[90000, 90000, 1]] });
    // 비교 기간(9/24~9/30)
    await s.order({ createdAt: "2026-09-25T03:00:00Z", total: 2000, items: [[2000, 2000, 1]] });

    const { status, body } = await call(salesRoute, "sales?from=2026-10-01&to=2026-10-07", await cookieOf(s.owner.email));
    expect(status).toBe(200);
    expect(body.current).toEqual({
      gross: 12000 + 8000 + 7000 + 1000,
      discount: 2000,
      rewardUsed: 0,
      shippingFee: 3000,
      paid: 13000 + 8000 + 7000 + 1000,
      refund: 4000,
      net: 29000 - 4000,
      paidOrders: 4,
    });
    expect(body.previous).toMatchObject({ paid: 2000, gross: 2000, paidOrders: 1 });
    expect(body.byMethod).toEqual([
      { method: "BANK_TRANSFER", paidOrders: 1, paid: 8000, refund: 0, net: 8000 },
      { method: "CARD", paidOrders: 2, paid: 20000, refund: 4000, net: 16000 },
      { method: "OTHER", paidOrders: 1, paid: 1000, refund: 0, net: 1000 },
    ]);
    expect(body.series.find((p: { bucket: string }) => p.bucket === "2026-10-03")).toEqual({ bucket: "2026-10-03", paid: 29000, refund: 4000, net: 25000 });
    expect(body.series).toHaveLength(7);
  });
});

const WEEK = () => parseStatsRange({ from: "2026-10-01", to: "2026-10-07" })!;

describe("상품 통계 GET /api/seller/stats/products", () => {
  it("결제 완료 품목만 상품별로 더하고(환불·결제 대기·취소 제외), 매출순으로 주며, 안 팔린 상품(임시 저장·삭제 제외)을 준다", async () => {
    const s = await shop();
    const card = await s.newProduct("카드 박스");
    const unsold = await s.newProduct("안 팔린 상품");
    await s.newProduct("숨긴 상품", "HIDDEN");
    await s.newProduct("임시 저장 상품", "DRAFT");
    await s.newProduct("지운 상품", "ON_SALE", true);
    const at = "2026-10-02T03:00:00Z";
    await s.order({ createdAt: at, items: [[5000, 5000, 2], [30000, 30000, 1, card.id]] });
    await s.order({ createdAt: at, items: [[30000, 30000, 2, card.id]] });
    await s.order({ createdAt: at, status: "REFUNDED", items: [[30000, 30000, 5, card.id]] });
    await s.order({ createdAt: at, status: "PENDING_PAYMENT", items: [[1000, 1000, 9, unsold.id]] });
    await s.order({ createdAt: at, status: "CANCELLED", items: [[1000, 1000, 9, unsold.id]] });
    await s.order({ createdAt: "2026-09-25T03:00:00Z", items: [[5000, 5000, 1]] });

    const { status, body } = await call(productsRoute, "products?from=2026-10-01&to=2026-10-07", await cookieOf(s.owner.email));
    expect(status).toBe(200);
    expect(body.top).toEqual([
      { productId: card.id, name: "카드 박스", deleted: false, quantity: 3, revenue: 90000, orders: 2 },
      { productId: s.product.id, name: "부스터 팩", deleted: false, quantity: 2, revenue: 10000, orders: 1 },
    ]);
    expect(body.current).toEqual({ quantity: 5, revenue: 100000, products: 2 });
    expect(body.previous).toEqual({ quantity: 1, revenue: 5000, products: 1 });
    expect(body.unsold.map((p: { name: string }) => p.name)).toEqual(["안 팔린 상품", "숨긴 상품"]);
    expect(body.unsoldCount).toBe(2);
  });

  it("다른 쇼핑몰 상품·판매는 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await b.order({ createdAt: "2026-10-02T03:00:00Z", items: [[5000, 5000, 7]] });
    const r = await productStats(db, a.ctx, WEEK());
    expect(r.top).toEqual([]);
    expect(r.unsold.map((p) => p.productId)).toEqual([a.product.id]);
  });
});

describe("회원 통계 GET /api/seller/stats/members", () => {
  it("신규 가입·탈퇴·구매 회원·재구매율(기간 끝까지 누적 결제 2건 이상)을 KST 경계로 센다", async () => {
    const s = await shop();
    // 기본 구매자(s.buyer)는 지금 가입 → 기간 밖으로 옮긴다
    await db.buyerMember.update({ where: { id: s.buyer.id }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    const early = await s.newBuyer("2026-09-30T14:59:59.999Z"); // 9/30 KST, 기간 밖
    const b1 = await s.newBuyer("2026-09-30T15:00:00Z"); // 10/1 0시 KST
    const b2 = await s.newBuyer("2026-10-03T03:00:00Z");
    const gone = await s.newBuyer("2026-10-03T03:00:00Z");
    await db.buyerMember.update({ where: { id: gone.id }, data: { status: "WITHDRAWN", deletedAt: new Date("2026-10-05T03:00:00Z") } });
    // s.buyer: 9월에 1건 + 기간 안 1건 → 재구매. b1: 기간 안 2건 → 재구매. b2: 1건. early: 결제 대기만.
    await s.order({ createdAt: "2026-09-10T03:00:00Z" });
    await s.order({ createdAt: "2026-10-02T03:00:00Z" });
    await s.order({ createdAt: "2026-10-02T03:00:00Z", buyerId: b1.id });
    await s.order({ createdAt: "2026-10-04T03:00:00Z", buyerId: b1.id, status: "REFUNDED" });
    await s.order({ createdAt: "2026-10-04T03:00:00Z", buyerId: b2.id });
    await s.order({ createdAt: "2026-10-04T03:00:00Z", buyerId: early.id, status: "PENDING_PAYMENT" });
    // 기간 뒤 주문은 재구매 판정에 쓰지 않는다
    await s.order({ createdAt: "2026-10-09T03:00:00Z", buyerId: b2.id });

    const { status, body } = await call(membersRoute, "members?from=2026-10-01&to=2026-10-07", await cookieOf(s.owner.email));
    expect(status).toBe(200);
    expect(body.current).toEqual({ signups: 3, withdrawals: 1, buyers: 3, repeatBuyers: 2, repeatRate: 0.6667 });
    expect(body.previous).toMatchObject({ signups: 1, buyers: 0, repeatRate: null });
    expect(body.series[0]).toEqual({ bucket: "2026-10-01", signups: 1, withdrawals: 0, buyers: 0 });
    expect(body.series[2]).toEqual({ bucket: "2026-10-03", signups: 2, withdrawals: 0, buyers: 0 });
    expect(body.series[3]).toEqual({ bucket: "2026-10-04", signups: 0, withdrawals: 0, buyers: 2 });
    expect(body.series[4]).toMatchObject({ bucket: "2026-10-05", withdrawals: 1 });
    expect(JSON.stringify(body)).not.toContain("구매자");
  });

  it("다른 쇼핑몰 회원·구매는 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    // a의 기본 구매자(오늘 가입)는 기간 밖으로 옮긴다
    await db.buyerMember.update({ where: { id: a.buyer.id }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    await b.newBuyer("2026-10-02T03:00:00Z");
    await b.order({ createdAt: "2026-10-02T03:00:00Z" });
    const r = await memberStats(db, a.ctx, WEEK());
    expect(r.current).toMatchObject({ signups: 0, buyers: 0, withdrawals: 0 });
  });
});

describe("방송 통계 GET /api/seller/stats/broadcasts", () => {
  async function queue(sellerId: string, order: { id: string; items: { id: string }[] }, broadcastSessionId: string | null) {
    let pos = 0;
    for (const it of order.items) {
      await db.queueItem.create({
        data: { sellerId, orderId: order.id, orderItemId: it.id, broadcastSessionId, position: ++pos, receivedAt: new Date(), nicknameSnapshot: "닉", productLabel: "상품", quantity: 1 },
      });
    }
  }

  it("기간에 시작한 방송별로 주문(여러 품목도 1건)·결제액·환불을 세고, 시청자 값은 준비 중으로 둔다", async () => {
    const s = await shop();
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, title: "금요 방송", status: "ENDED", startedAt: new Date("2026-10-02T11:00:00Z"), endedAt: new Date("2026-10-02T13:00:00Z") } });
    const quiet = await db.broadcastSession.create({ data: { sellerId: s.seller.id, title: null, status: "ENDED", startedAt: new Date("2026-10-03T11:00:00Z") } });
    const old = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", startedAt: new Date("2026-09-30T14:00:00Z") } });
    const at = "2026-10-02T12:00:00Z";
    await queue(s.seller.id, await s.order({ createdAt: at, total: 20000, items: [[5000, 5000, 1], [5000, 5000, 1]] }), live.id);
    await queue(s.seller.id, await s.order({ createdAt: at, total: 10000, status: "REFUNDED", refundAmount: 7000, items: [[5000, 5000, 1]] }), live.id);
    await queue(s.seller.id, await s.order({ createdAt: at, total: 3000, items: [[3000, 3000, 1]] }), null);
    await queue(s.seller.id, await s.order({ createdAt: at, total: 4000, items: [[4000, 4000, 1]] }), old.id);
    // 방송 시간 일반 주문: 주문대기에 안 올라간 결제 주문(방송 종료 뒤 2시간 안까지). 결제 대기·2시간 뒤 주문은 빼고, 환불은 따로 센다
    await s.order({ createdAt: "2026-10-02T14:59:00Z", total: 6000, items: [[6000, 6000, 1]] });
    await s.order({ createdAt: "2026-10-02T14:00:00Z", total: 2000, status: "REFUNDED", refundAmount: 2000, items: [[2000, 2000, 1]] });
    await s.order({ createdAt: "2026-10-02T12:30:00Z", total: 9000, status: "PENDING_PAYMENT", items: [[9000, 9000, 1]] });
    await s.order({ createdAt: "2026-10-02T15:00:00Z", total: 8000, items: [[8000, 8000, 1]] });

    const { status, body } = await call(broadcastsRoute, "broadcasts?from=2026-10-01&to=2026-10-07", await cookieOf(s.owner.email));
    expect(status).toBe(200);
    expect(body.broadcasts.map((b: { id: string }) => b.id)).toEqual([quiet.id, live.id]);
    expect(body.broadcasts[1]).toMatchObject({ title: "금요 방송", orders: 2, paid: 30000, refunded: 1, refund: 7000, net: 23000 });
    expect(body.broadcasts[0]).toMatchObject({ title: null, orders: 0, paid: 0, net: 0 });
    expect(body.total).toEqual({ broadcasts: 2, orders: 2, paid: 30000, net: 23000 });
    // 주문대기에 방송 없이 올라간 주문(3,000원)과 안 올라간 주문 2건. 다른 방송 주문대기에 올라간 4,000원은 넣지 않는다
    expect(body.broadcasts[1].general).toEqual({ orders: 3, paid: 11000, refunded: 1, refund: 2000, net: 9000 });
    expect(body.broadcasts[0].general).toEqual({ orders: 0, paid: 0, refunded: 0, refund: 0, net: 0 });
    expect(body.general).toEqual({ orders: 3, paid: 11000, net: 9000 });
    expect(body.unavailable).toEqual(["viewers", "conversion"]);
  });

  it("다른 쇼핑몰 방송·주문은 섞이지 않고, 플랜 기능은 OVERLAY를 따른다", async () => {
    const a = await shop();
    const b = await shop();
    const bLive = await db.broadcastSession.create({ data: { sellerId: b.seller.id, status: "ENDED", startedAt: new Date("2026-10-02T11:00:00Z") } });
    await queue(b.seller.id, await b.order({ createdAt: "2026-10-02T12:00:00Z", items: [[5000, 5000, 1]] }), bLive.id);
    expect((await broadcastStats(db, a.ctx, WEEK())).broadcasts).toEqual([]);

    // 오버레이 전용 플랜: 방송 통계는 열리고, 상품·회원 통계는 막힌다
    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    await db.sellerSubscription.create({ data: { sellerId: a.seller.id, planId: plan.id, status: "ACTIVE" } });
    const cookie = await cookieOf(a.owner.email);
    expect((await call(broadcastsRoute, "broadcasts?from=2026-10-01&to=2026-10-07", cookie)).status).toBe(200);
    expect((await call(productsRoute, "products?from=2026-10-01&to=2026-10-07", cookie)).body).toEqual({ error: "plan_feature_required" });
    expect((await call(membersRoute, "members?from=2026-10-01&to=2026-10-07", cookie)).body).toEqual({ error: "plan_feature_required" });
  });

  it("통계 권한 없는 직원은 상품·회원·방송 통계도 403", async () => {
    const s = await shop();
    const staff = await createSellerUser(s.seller.id, { permissions: ["BROADCAST_RUN", "OVERLAY_EDIT", "PRODUCT_MANAGE", "MEMBER_POINTS"] });
    const cookie = await cookieOf(staff.email);
    for (const [route, path] of [[productsRoute, "products"], [membersRoute, "members"], [broadcastsRoute, "broadcasts"]] as const) {
      expect((await call(route, `${path}?from=2026-10-01&to=2026-10-07`, cookie)).status, path).toBe(403);
    }
  });
});
