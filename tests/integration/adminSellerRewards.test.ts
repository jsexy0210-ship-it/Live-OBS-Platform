import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as rewardsRoute } from "../../app/api/admin/sellers/[sellerId]/rewards/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { createAdmin, createBuyer, createSeller, db, resetDb } from "./helpers";

// 마스터 관리자 파트너스 상세 적립금 설정 탭(MA-012-7)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000" };
async function cookieOf(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const get = (cookie: string, id: string) =>
  rewardsRoute(new Request(`http://localhost:3000/api/admin/sellers/${id}/rewards`, { headers: { ...H, cookie } }), { params: Promise.resolve({ sellerId: id }) });
type Body = {
  policy: { saved: boolean; earnTiming: string | null; revokeMode: string | null; expiryYears: number; useMaxRatio: number | null; grades: { name: string; cardRate: number; bankTransferRate: number; members: number }[] };
  limits: { rateMax: number; withinLimits: boolean };
  livePayout: { enabled: boolean; changedByName: string | null };
  totals: { balance: number; monthGranted: number; monthUsed: number; pending: { count: number; amount: number }; failed: { count: number; amount: number } };
  history: unknown[];
  anomalies: Record<string, { status: string; ratio?: number | null; count?: number; amount?: number }>;
};
const json = async (r: Response) => (await r.json()) as Body;

describe("파트너스 적립금 설정 탭 GET /api/admin/sellers/{id}/rewards", () => {
  it("정책을 저장하지 않은 파트너스는 saved=false, 합계 0", async () => {
    const cookie = await cookieOf("READ_ONLY");
    const { seller } = await createSeller();
    const b = await json(await get(cookie, seller.id));
    expect(b.policy).toMatchObject({ saved: false, earnTiming: null, expiryYears: 3 });
    expect(b.totals).toMatchObject({ balance: 0, monthGranted: 0, monthUsed: 0, pending: { count: 0 }, failed: { count: 0 } });
    expect(b.anomalies.balanceRatio).toMatchObject({ status: "OK", ratio: null });
  });

  it("정책·등급별 회원 수·합계·이상 징후를 주고 다른 파트너스 데이터는 섞이지 않는다", async () => {
    const cookie = await cookieOf("CS");
    const { seller, grade } = await createSeller();
    const other = await createSeller();
    const m1 = await createBuyer(seller.id, grade.id);
    const m2 = await createBuyer(seller.id, grade.id);
    const om = await createBuyer(other.seller.id, other.grade.id);
    await db.rewardPolicy.create({
      data: { sellerId: seller.id, rates: { [grade.id]: { card: 1, bankTransfer: 2 } }, earnTiming: "ON_PAYMENT", revokeMode: "AUTO", useMaxRatio: 30, livePayoutEnabled: true, livePayoutChangedAt: new Date() },
    });
    await db.rewardBalance.createMany({
      data: [
        { sellerId: seller.id, buyerMemberId: m1.id, balance: 9000 },
        { sellerId: seller.id, buyerMemberId: m2.id, balance: 1000 },
        { sellerId: other.seller.id, buyerMemberId: om.id, balance: 777777 },
      ],
    });
    const at = new Date();
    const row = (i: number, type: "EARN" | "USE" | "ADJUST", amount: number, status: "SUCCEEDED" | "PENDING" | "FAILED") => ({
      sellerId: seller.id, buyerMemberId: m1.id, type, amount, status, testMode: false, idempotencyKey: `k${i}`, createdAt: at, processedAt: at,
    });
    await db.rewardLedger.createMany({
      data: [row(1, "EARN", 3000, "SUCCEEDED"), row(2, "ADJUST", 500, "SUCCEEDED"), row(3, "USE", -1200, "SUCCEEDED"), row(4, "EARN", 800, "PENDING"), row(5, "EARN", 100, "FAILED"), row(6, "EARN", 100, "FAILED"), row(7, "EARN", 100, "FAILED")],
    });
    await db.order.create({ data: { sellerId: seller.id, orderNo: 1, buyerMemberId: m1.id, status: "PAID", broadcastNicknameSnapshot: "n", totalAmount: 20000, paidAt: at } });

    const b = await json(await get(cookie, seller.id));
    expect(b.policy).toMatchObject({ saved: true, earnTiming: "ON_PAYMENT", revokeMode: "AUTO", useMaxRatio: 30 });
    expect(b.policy.grades.find((g) => g.cardRate === 1)).toMatchObject({ bankTransferRate: 2, members: 2 });
    expect(b.limits).toEqual({ rateMax: 10, withinLimits: true });
    expect(b.livePayout.enabled).toBe(true);
    expect(b.totals).toMatchObject({ balance: 10000, monthGranted: 3500, monthUsed: 1200, pending: { count: 1, amount: 800 }, failed: { count: 3, amount: 300 } });
    expect(b.anomalies.balanceRatio).toMatchObject({ status: "WARN", ratio: 50 });
    expect(b.anomalies.manualGrant).toMatchObject({ status: "OK", count: 1, amount: 500 });
    expect(b.anomalies.concentration).toMatchObject({ status: "WARN", ratio: 90 });
    expect(b.anomalies.failRepeat).toMatchObject({ status: "WARN", count: 3 });
  });

  it("없는 파트너스·형식 오류 404, 로그인 없음 401", async () => {
    const cookie = await cookieOf("OPERATIONS");
    expect((await get(cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await get(cookie, "abc")).status).toBe(404);
    const { seller } = await createSeller();
    expect((await get("", seller.id)).status).toBe(401);
  });
});
