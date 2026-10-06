import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as costRoute } from "../../app/api/admin/infra/cost/route";
import { PUT as pricesRoute } from "../../app/api/admin/infra/prices/route";
import { GET as summaryRoute } from "../../app/api/admin/infra/summary/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { createAdmin, createBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(async () => {
  vi.unstubAllEnvs();
  await resetDb();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const adminCookie = async (role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") => {
  const admin = await createAdmin(role);
  const s = await createAdminSession(db, admin.id, {});
  return { cookie: `lo_admin=${s.token}`, id: admin.id };
};
const get = (route: typeof costRoute, path: string, cookie?: string) => route(new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} }));
const putPrices = (cookie: string, body: unknown) =>
  pricesRoute(new Request(`${BASE}/api/admin/infra/prices`, { method: "PUT", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("인프라 비용", () => {
  it("단가 입력·비용·요약은 최고관리자만(401·403)", async () => {
    for (const [r, p] of [[costRoute, "/api/admin/infra/cost"], [summaryRoute, "/api/admin/infra/summary"]] as const) {
      expect((await get(r, p)).status).toBe(401);
      for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) expect((await get(r, p, (await adminCookie(role)).cookie)).status).toBe(403);
    }
    expect((await putPrices((await adminCookie("OPERATIONS")).cookie, { expectedVersion: 0, prices: { mailWonEach: 5 } })).status).toBe(403);
  });

  it("단가가 없으면 단가 없음, 있으면 추정. 메일 건수·결제 수수료는 이번 달 사용량으로 센다. 실제 금액은 null", async () => {
    const { cookie } = await adminCookie("SUPER_ADMIN");
    let body = await (await get(costRoute, "/api/admin/infra/cost", cookie)).json();
    expect(body.estimated).toBe(true);
    expect(body.actual).toBeNull();
    expect(body.items.find((i: { key: string }) => i.key === "server")).toMatchObject({ status: "no_price", accruedWon: null });
    expect(body.items.find((i: { key: string }) => i.key === "sms")).toMatchObject({ status: "not_measured" });

    const month = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7);
    await db.mailDelivery.createMany({ data: [{ kind: "x", month, status: "SENT" }, { kind: "x", month, status: "SENT" }, { kind: "x", month, status: "FAILED" }] });
    const a = await createSeller();
    const buyer = await createBuyer(a.seller.id, a.grade.id);
    const order = await db.order.create({ data: { sellerId: a.seller.id, orderNo: 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 100000 } });
    await db.payment.create({ data: { sellerId: a.seller.id, orderId: order.id, provider: "nicepay", method: "CARD", status: "PARTIAL_CANCELLED", amount: 100000, cancelledAmount: 20000, approvedAt: new Date() } });

    const r = await putPrices(cookie, { expectedVersion: 0, prices: { serverMonthlyWon: 30000, mailWonEach: 10, pgFeeRatePct: 3.3 } });
    expect(r.status).toBe(200);
    body = await (await get(costRoute, "/api/admin/infra/cost", cookie)).json();
    expect(body.priceVersion).toBe(1);
    const item = (k: string) => body.items.find((i: { key: string }) => i.key === k);
    expect(item("server")).toMatchObject({ status: "estimated", unitPrice: 30000, projectedWon: 30000 });
    expect(item("mail")).toMatchObject({ status: "estimated", usage: { value: 2, unit: "count" }, accruedWon: 20 });
    expect(item("pgFee")).toMatchObject({ usage: { value: 80000, unit: "won" }, accruedWon: 2640 });
    expect(body.totals.accruedWon).toBe(item("server").accruedWon + 20 + 2640);
    expect(body.totals.projectedWon).toBeGreaterThanOrEqual(30000 + 2640);
  });

  it("한도 기능: 도우미·외부 API 사용액과 정지 상태를 낸다", async () => {
    const { cookie } = await adminCookie("SUPER_ADMIN");
    const period = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7);
    await db.assistantMonthUsage.create({ data: { month: period, usedMilliWon: 2500 } });
    await db.externalApiUsage.create({ data: { provider: "gemini", period, usedWon: 10000, limitWon: 10000, stoppedAt: new Date() } });
    const body = await (await get(costRoute, "/api/admin/infra/cost", cookie)).json();
    expect(body.limited).toEqual([
      { key: "assistant", usedWon: 3, limitWon: 10000, stopped: false, stoppedAt: null },
      { key: "externalApi:gemini", usedWon: 10000, limitWon: 10000, stopped: true, stoppedAt: expect.any(String) },
    ]);
    expect(body.totals.accruedWon).toBe(10003);
    const sum = await (await get(summaryRoute, "/api/admin/infra/summary", cookie)).json();
    expect(sum.warnings.limitStopped).toBe(1);
    expect(sum.warnings.total).toBe(sum.warnings.capacity + 1);
    expect(sum.cost).toMatchObject({ estimated: true, accruedWon: 10003 });
    expect(sum.servers[0]).toMatchObject({ diskPct: expect.any(Number), memoryPct: expect.any(Number) });
  });

  it("단가 입력 검증·겹침 방지·지우기, 로그 추적에 전후 값이 남는다", async () => {
    const { cookie, id } = await adminCookie("SUPER_ADMIN");
    for (const bad of [{ prices: { unknown: 1 } }, { prices: { serverMonthlyWon: -1 } }, { prices: { serverMonthlyWon: 1.5 } }, { prices: { pgFeeRatePct: 101 } }, { prices: { pgFeeRatePct: 3.333 } }, { prices: {} }]) {
      const r = await putPrices(cookie, { expectedVersion: 0, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await putPrices(cookie, { prices: { mailWonEach: 1 } })).status).toBe(400);
    expect((await putPrices(cookie, { expectedVersion: 0, prices: { serverMonthlyWon: 100 } })).status).toBe(200);
    expect((await putPrices(cookie, { expectedVersion: 0, prices: { serverMonthlyWon: 200 } })).status).toBe(409);
    const r = await putPrices(cookie, { expectedVersion: 1, prices: { serverMonthlyWon: null, diskMonthlyWon: 50 } });
    expect(await r.json()).toEqual({ prices: { diskMonthlyWon: 50 }, version: 2 });
    const logs = await db.auditLog.findMany({ where: { action: "admin.infra.price_update" }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ actorId: id, before: { serverMonthlyWon: 100 }, after: { diskMonthlyWon: 50 } });
  });
});
