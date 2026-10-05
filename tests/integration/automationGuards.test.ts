import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as checkRoute } from "../../app/api/automation/check/route";
import { GET as jobsRoute } from "../../app/api/automation/jobs/route";
import { GET as jobRoute } from "../../app/api/automation/jobs/[jobId]/route";
import { POST as purchaseRoute } from "../../app/api/automation/purchase/route";
import { POST as reconnectRoute } from "../../app/api/automation/reconnect/route";
import { POST as cancelRoute } from "../../app/api/automation/jobs/[jobId]/cancel/route";
import { POST as resumeRoute } from "../../app/api/automation/jobs/[jobId]/resume/route";
import { POST as refundRoute } from "../../app/api/automation/jobs/[jobId]/refund-request/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 자동 연결 서버 가드: 로그인만이 아니라 요금제 기능(오버레이 이상)과 권한(대표자 전용, 구매·작업 변경은 결제가 따른다)을 서버에서 확인한다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function cookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
const H = (c: string) => ({ host: "localhost:3000", origin: "http://localhost:3000", cookie: c, "content-type": "application/json", "idempotency-key": "k-0123456789abcdef" });
const url = "http://localhost:3000/api/automation";
const ID = "00000000-0000-4000-8000-000000000001";
const ctxParam = { params: Promise.resolve({ jobId: ID }) };

type Call = (c: string) => Promise<Response>;
const calls: Record<string, Call> = {
  check: (c) => checkRoute(new Request(`${url}/check`, { method: "POST", headers: H(c), body: JSON.stringify({ shopUrl: "https://x.cafe24.com" }) })),
  list: (c) => jobsRoute(new Request(`${url}/jobs`, { headers: H(c) })),
  detail: (c) => jobRoute(new Request(`${url}/jobs/${ID}`, { headers: H(c) }), ctxParam),
  purchase: (c) => purchaseRoute(new Request(`${url}/purchase`, { method: "POST", headers: H(c), body: "{}" })),
  reconnect: (c) => reconnectRoute(new Request(`${url}/reconnect`, { method: "POST", headers: H(c), body: "{}" })),
  cancel: (c) => cancelRoute(new Request(`${url}/jobs/${ID}/cancel`, { method: "POST", headers: H(c), body: "{}" }), ctxParam),
  resume: (c) => resumeRoute(new Request(`${url}/jobs/${ID}/resume`, { method: "POST", headers: H(c), body: "{}" }), ctxParam),
  refund: (c) => refundRoute(new Request(`${url}/jobs/${ID}/refund-request`, { method: "POST", headers: H(c), body: "{}" }), ctxParam),
};

async function setup() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, owner };
}
const errorOf = async (r: Response) => ((await r.json()) as { error?: string }).error;

describe("자동 연결 서버 가드", () => {
  it("로그인하지 않으면 모든 경로가 401이다", async () => {
    for (const [name, call] of Object.entries(calls)) expect((await call("")).status, name).toBe(401);
  });

  it("권한 없는 직원·쇼핑몰 설정만 가진 직원은 모든 경로가 403이다(구매·작업 변경은 결제가 따라 대표자 전용). 대표자는 막히지 않는다", async () => {
    const { seller, owner } = await setup();
    const none = await createSellerUser(seller.id, { permissions: [] });
    const shop = await createSellerUser(seller.id, { permissions: ["SHOP_SETTINGS"] });
    for (const u of [none, shop]) {
      const c = await cookie(u.email);
      for (const [name, call] of Object.entries(calls)) {
        const r = await call(c);
        expect(r.status, `${u.email} ${name}`).toBe(403);
      }
    }
    const c = await cookie(owner.email);
    for (const name of ["check", "list", "detail"]) expect((await calls[name](c)).status, name).not.toBe(403);
  });

  it("오버레이 이상 요금제 기능이 없는 파트너스(첫 결제 전 통합 요금제·알 수 없는 요금제)는 대표자도 모든 경로가 403 plan_feature_required이다", async () => {
    const { seller, owner } = await setup();
    const plan = await db.subscriptionPlan.create({ data: { code: "UNKNOWN_PLAN", name: "x", listPrice: 1, salePrice: 1 } });
    await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id } });
    const c = await cookie(owner.email);
    for (const [name, call] of Object.entries(calls)) {
      const r = await call(c);
      expect(r.status, name).toBe(403);
      expect(await errorOf(r), name).toBe("plan_feature_required");
    }
  });

  it("오버레이 요금제는 기능이 있어 요금제 가드를 통과한다(권한은 대표자 기준)", async () => {
    const { seller, owner } = await setup();
    const plan = await db.subscriptionPlan.upsert({ where: { code: "OVERLAY_ONLY" }, create: { code: "OVERLAY_ONLY", name: "o", listPrice: 1, salePrice: 1 }, update: {} });
    await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id } });
    const c = await cookie(owner.email);
    expect((await calls.list(c)).status).toBe(200);
    expect((await calls.check(c)).status).not.toBe(403);
  });
});
