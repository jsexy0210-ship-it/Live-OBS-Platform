import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as ordersRoute } from "../../app/api/admin/sellers/[sellerId]/orders/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { createAdmin, createBuyer, createPaidOrderItem, createSeller, db, resetDb } from "./helpers";

// 마스터 관리자 파트너스 상세 주문 현황 탭(MA-012-6)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000" };
async function cookieOf(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const get = (cookie: string, id: string, qs = "") =>
  ordersRoute(new Request(`http://localhost:3000/api/admin/sellers/${id}/orders${qs}`, { headers: { ...H, cookie } }), { params: Promise.resolve({ sellerId: id }) });
type Body = {
  summary: { todayOrders: number; monthOrders: number; monthAmount: number; cancelRefundRate: number | null; paymentFailRate7d: number | null; disputeCount: null };
  orders: { orderNo: number; nickname: string; payment: string; queue: string | null; amount: number; productName: string | null }[];
  total: number;
  anomalies: Record<string, { status: string; count?: number }>;
  monthly: { month: string; count: number }[];
};
const json = async (r: Response) => (await r.json()) as Body;

async function makeOrder(sellerId: string, buyerId: string, over: { status?: "PENDING_PAYMENT" | "CANCELLED" | "REFUNDED"; payment?: "FAILED" | "PAID"; nickname?: string; createdAt?: Date } = {}) {
  const o = await createPaidOrderItem(sellerId, buyerId);
  await db.order.update({
    where: { id: o.order.id },
    data: { status: over.status ?? "PAID", broadcastNicknameSnapshot: over.nickname ?? "닉네임", ...(over.status ? { paidAt: null } : {}), ...(over.createdAt ? { createdAt: over.createdAt } : {}) },
  });
  if (over.payment)
    await db.payment.create({ data: { sellerId, orderId: o.order.id, provider: "fake", method: "CARD", status: over.payment, amount: 5000 } });
  return o;
}

describe("파트너스 주문 현황 GET /api/admin/sellers/{id}/orders", () => {
  it("행의 결제·주문대기 표시, 상태·검색 필터, 번호형 쪽, 판매자 격리, 조회 전용도 읽기", async () => {
    const cookie = await cookieOf("READ_ONLY");
    const { seller, grade } = await createSeller();
    const other = await createSeller();
    const buyer = await createBuyer(seller.id, grade.id);
    const otherBuyer = await createBuyer(other.seller.id, other.grade.id);
    const paid = await makeOrder(seller.id, buyer.id, { nickname: "별빛사냥꾼" });
    await db.queueItem.create({ data: { sellerId: seller.id, orderId: paid.order.id, orderItemId: paid.item.id, status: "WAITING", position: 1, receivedAt: new Date(), nicknameSnapshot: "별빛사냥꾼", productLabel: "부스터 팩", quantity: 1 } });
    await makeOrder(seller.id, buyer.id, { status: "PENDING_PAYMENT", payment: "FAILED" });
    await makeOrder(seller.id, buyer.id, { status: "PENDING_PAYMENT" });
    const refund = await makeOrder(seller.id, buyer.id);
    await db.returnRequest.create({ data: { sellerId: seller.id, orderId: refund.order.id, buyerMemberId: buyer.id, kind: "RETURN", reason: "CHANGE_OF_MIND" } });
    const exchange = await makeOrder(seller.id, buyer.id);
    await db.returnRequest.create({ data: { sellerId: seller.id, orderId: exchange.order.id, buyerMemberId: buyer.id, kind: "EXCHANGE", reason: "CHANGE_OF_MIND" } });
    await makeOrder(other.seller.id, otherBuyer.id, { nickname: "남의주문" });

    const all = await json(await get(cookie, seller.id));
    expect(all.total).toBe(5);
    expect(all.orders.map((o) => o.nickname)).not.toContain("남의주문");
    const states = all.orders.map((o) => o.payment).sort();
    expect(states).toEqual(["FAILED", "PAID", "PAID", "PENDING", "REFUND_REQUESTED"]);
    expect(all.orders.find((o) => o.nickname === "별빛사냥꾼")).toMatchObject({ queue: "WAITING", productName: "부스터 팩", amount: 5000 });

    for (const [status, n] of [["paid", 2], ["failed", 1], ["pending", 1], ["refund_requested", 1]] as const) expect((await json(await get(cookie, seller.id, `?status=${status}`))).total).toBe(n);
    expect((await json(await get(cookie, seller.id, "?q=별빛"))).total).toBe(1);
    expect((await json(await get(cookie, seller.id, `?q=${paid.order.orderNo}`))).orders[0].orderNo).toBe(paid.order.orderNo);
    const p2 = await json(await get(cookie, seller.id, "?pageSize=2&page=3"));
    expect(p2).toMatchObject({ total: 5 });
    expect(p2.orders).toHaveLength(1);
    expect((await json(await get(cookie, seller.id, "?range=today"))).total).toBe(5);
  });

  it("요약·이상 징후·월별 추이", async () => {
    const cookie = await cookieOf("CS");
    const { seller, grade } = await createSeller();
    const buyer = await createBuyer(seller.id, grade.id);
    await makeOrder(seller.id, buyer.id);
    await makeOrder(seller.id, buyer.id, { status: "CANCELLED" });
    const old = new Date(Date.now() - 400 * 86400_000);
    await makeOrder(seller.id, buyer.id, { createdAt: old });
    // 결제 실패 연속 3건(최근 결제 PAID 없음)
    for (let i = 0; i < 3; i++) await makeOrder(seller.id, buyer.id, { status: "PENDING_PAYMENT", payment: "FAILED" });
    const b = await json(await get(cookie, seller.id));
    expect(b.summary).toMatchObject({ disputeCount: null, paymentFailRate7d: 100 });
    expect(b.summary.todayOrders).toBe(5);
    expect(b.summary.cancelRefundRate).toBe(20);
    expect(b.anomalies.paymentFailStreak).toMatchObject({ status: "WARN", count: 3 });
    expect(b.anomalies.refundRequestOverdue.status).toBe("OK");
    expect(b.monthly.at(-1)?.count).toBe(5);
    expect(b.monthly.some((m) => m.count === 1)).toBe(false); // 400일 전 주문은 최근 4개월 밖
  });

  it("없는 파트너스·형식 오류 404, 잘못된 조건 400, 로그인 없음 401", async () => {
    const cookie = await cookieOf("OPERATIONS");
    const { seller } = await createSeller();
    expect((await get(cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await get(cookie, "abc")).status).toBe(404);
    for (const qs of ["?range=year", "?status=x", "?page=0", "?pageSize=101"]) expect((await get(cookie, seller.id, qs)).status).toBe(400);
    expect((await get("", seller.id)).status).toBe(401);
  });
});
