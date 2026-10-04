import type { OrderStatus, PaymentMethod } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as ordersRoute } from "../../app/api/seller/stats/orders/route";
import { GET as salesRoute } from "../../app/api/seller/stats/sales/route";
import { loginSeller } from "../../lib/server/auth/login";
import { orderStats } from "../../lib/server/stats/orders";
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
  // 품목: [정가, 판매 단가, 수량]
  items?: [number | null, number, number][];
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
        buyerMemberId: buyer.id,
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
    for (const [list, unit, qty] of o.items ?? []) {
      await db.orderItem.create({
        data: {
          sellerId: seller.id,
          orderId: created.id,
          productId: product.id,
          optionId: option.id,
          productNameSnapshot: product.name,
          optionNameSnapshot: option.name,
          unitPrice: unit,
          listUnitPrice: list,
          quantity: qty,
        },
      });
    }
    return created;
  };
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, order, ctx };
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
