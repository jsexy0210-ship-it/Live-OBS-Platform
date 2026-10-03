import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as jobRoute } from "../../app/api/automation/jobs/[jobId]/route";
import { loginSeller } from "../../lib/server/auth/login";
import { AUTOMATION_CONSENT } from "../../lib/server/automation/config";
import { FakeBrowserExecutor, FakeObsBridge, FakePlanner, FakeSecretVault } from "../../lib/server/automation/fakes";
import { cafe24Playbook } from "../../lib/server/automation/playbooks/cafe24";
import { PRACTICE_STREAK_REQUIRED, playbookReadiness, runPractice, supportedPlaybookIds } from "../../lib/server/automation/practice";
import { purchaseAutomation } from "../../lib/server/automation/purchase";
import { runOnce } from "../../lib/server/automation/worker";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { prisma } from "../../lib/server/db";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: AUTOMATION_CONSENT.version };
// 작업서의 화면 단서를 모두 만족하는 관리 화면(시험용 쇼핑몰 흉내)
const MATCHING_ADMIN = "앱 설치 · 설치 완료 · 주문 알림 · 저장";
const SCRIPTED_ACTIONS = Object.values(cafe24Playbook.steps).reduce((n, s) => n + s.actions.length, 0);
let k = 0;

function runtime(pageText = MATCHING_ADMIN) {
  const rt = { planner: new FakePlanner(), browser: new FakeBrowserExecutor(), obs: new FakeObsBridge(), vault: new FakeSecretVault() };
  rt.browser.pageText = () => pageText;
  return rt;
}

async function boughtWithShop(shopUrl = "https://myshop.cafe24.com") {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const plan = await db.subscriptionPlan.upsert({ where: { code: "STANDARD" }, create: { code: "STANDARD", name: "월 구독", listPrice: 300000, salePrice: 199000 }, update: {} });
  await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id, billingKeyCipher: sealBillingKey("fake-bk-pb", seller.id), cardLabel: "테스트카드" } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const r = await purchaseAutomation(db, new FakeBillingProvider(), ctx, { idempotencyKey: `pb-key-${++k}-xxxx`, consent, shopUrl });
  if (!r.ok) throw new Error(r.reason);
  return { seller, owner, ctx, jobId: r.jobId };
}

const W = { workerId: "w1" };
const job = (id: string) => db.automationJob.findUniqueOrThrow({ where: { id } });

describe("작업서 우선 실행", () => {
  // 구매는 지원 목록(연습 검증된 작업서)일 때만 되므로 먼저 검증 기록을 만든다
  beforeEach(async () => {
    for (let i = 0; i < PRACTICE_STREAK_REQUIRED; i++) await runPractice(db, runtime(), cafe24Playbook);
  });

  it("쇼핑몰 주소로 작업서를 고르고, 화면이 작업서와 맞으면 판단 모델을 부르지 않고 끝까지 실행한다", async () => {
    const rt = runtime();
    const a = await boughtWithShop();
    expect(await job(a.jobId)).toMatchObject({ playbookId: "cafe24", playbookVersion: cafe24Playbook.version });
    expect(await runOnce(db, rt, W)).toBe("succeeded");
    expect(await job(a.jobId)).toMatchObject({ status: "SUCCEEDED", plannerCalls: 0, playbookActions: SCRIPTED_ACTIONS, costUsed: 0, deviatedSteps: [] });
    expect(rt.planner.inputs).toHaveLength(0);
    expect((await job(a.jobId)).verificationEvidence).toMatchObject({ shownOnOverlay: true });
  });

  it("작업서가 없는 작업(작업서 정보가 지워진 경우)은 판단 모델로만 진행한다", async () => {
    const rt = runtime();
    const a = await boughtWithShop();
    await db.automationJob.update({ where: { id: a.jobId }, data: { playbookId: null, playbookVersion: null } });
    expect(await runOnce(db, rt, W)).toBe("succeeded");
    const j = await job(a.jobId);
    expect(j.playbookActions).toBe(0);
    expect(j.plannerCalls).toBeGreaterThan(0);
    expect(rt.planner.inputs.every((i) => i.reference === null)).toBe(true);
  });

  it("화면이 작업서와 다르면 그 단계만 판단 모델이 작업서 설명·사례를 참고해 이어 가고, 이탈 단계를 남긴다", async () => {
    const rt = runtime("앱 설치 · 설치 완료 · 저장");
    const a = await boughtWithShop();
    expect(await runOnce(db, rt, W)).toBe("succeeded");
    const j = await job(a.jobId);
    expect(j.deviatedSteps).toEqual(["webhook_setup"]);
    expect(j.plannerCalls).toBeGreaterThan(0);
    expect(j.playbookActions).toBe(SCRIPTED_ACTIONS - cafe24Playbook.steps.webhook_setup.actions.length);
    expect(new Set(rt.planner.inputs.map((i) => i.step.key))).toEqual(new Set(["webhook_setup"]));
    expect(rt.planner.inputs[0].reference?.guide).toBe(cafe24Playbook.steps.webhook_setup.guide);
  });

  it("작업서의 예외 화면(로그인 요구)이면 판단 호출 없이 고객 행동 대기로 바꾼다", async () => {
    const rt = runtime("로그인이 필요해요");
    const a = await boughtWithShop();
    expect(await runOnce(db, rt, W)).toBe("needs_customer");
    expect(await job(a.jobId)).toMatchObject({ status: "NEEDS_CUSTOMER", customerAction: "LOGIN", plannerCalls: 0 });
  });

  it("작업 중 작업서 버전이 바뀌었으면 작업서를 쓰지 않고 판단 모델로만 진행한다", async () => {
    const rt = runtime();
    const a = await boughtWithShop();
    await db.automationJob.update({ where: { id: a.jobId }, data: { playbookVersion: cafe24Playbook.version + 100 } });
    expect(await runOnce(db, rt, W)).toBe("succeeded");
    expect(await job(a.jobId)).toMatchObject({ playbookActions: 0 });
  });

  it("작업 조회 응답에 작업서·플랫폼 이름이 나가지 않는다", async () => {
    const a = await boughtWithShop();
    await runOnce(db, runtime(), W);
    const r = await loginSeller(db, { email: a.owner.email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    const res = await jobRoute(
      new Request(`http://localhost:3000/api/automation/jobs/${a.jobId}`, { headers: { host: "localhost:3000", cookie: `lo_seller=${r.token}` } }),
      { params: Promise.resolve({ jobId: a.jobId }) },
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/cafe24|playbook/i);
  });
});

describe("연습 모드와 지원 목록", () => {
  it(`연속 ${PRACTICE_STREAK_REQUIRED}회 성공해야 지원 목록에 오르고, 실패·화면 이탈이 끼면 처음부터 다시 센다`, async () => {
    const ok = runtime();
    for (let i = 0; i < PRACTICE_STREAK_REQUIRED - 1; i++) expect((await runPractice(db, ok, cafe24Playbook)).outcome).toBe("SUCCEEDED");
    expect(await playbookReadiness(db, cafe24Playbook)).toMatchObject({ streak: PRACTICE_STREAK_REQUIRED - 1, verified: false });
    expect(await supportedPlaybookIds(db)).toEqual([]);

    const drifted = await runPractice(db, runtime("앱 설치 · 설치 완료 · 저장"), cafe24Playbook);
    expect(drifted).toMatchObject({ outcome: "SUCCEEDED", deviatedSteps: ["webhook_setup"] });
    expect(drifted.plannerCalls).toBeGreaterThan(0);
    expect(await playbookReadiness(db, cafe24Playbook)).toMatchObject({ streak: 0, verified: false });

    const login = await runPractice(db, runtime("로그인이 필요해요"), cafe24Playbook);
    expect(login).toMatchObject({ outcome: "NEEDS_CUSTOMER", failedStep: "shop_connect", reason: "LOGIN" });

    for (let i = 0; i < PRACTICE_STREAK_REQUIRED; i++) await runPractice(db, ok, cafe24Playbook);
    const ready = await playbookReadiness(db, cafe24Playbook);
    expect(ready).toMatchObject({ streak: PRACTICE_STREAK_REQUIRED, verified: true, needsReverify: false, runs: PRACTICE_STREAK_REQUIRED * 2 + 1 });
    expect(ready.successRate).toBeCloseTo((PRACTICE_STREAK_REQUIRED * 2) / (PRACTICE_STREAK_REQUIRED * 2 + 1));
    expect(ready.avgPlannerCalls).not.toBeNull();
    expect(await supportedPlaybookIds(db)).toEqual(["cafe24"]);
  });

  it("검증 뒤 고객 작업에서 화면이 작업서와 다르면(관리 화면 변경 의심) 지원 목록에서 빠지고 재검증 대상이 된다", async () => {
    for (let i = 0; i < PRACTICE_STREAK_REQUIRED; i++) await runPractice(db, runtime(), cafe24Playbook);
    expect((await playbookReadiness(db, cafe24Playbook)).verified).toBe(true);
    await boughtWithShop();
    expect(await runOnce(db, runtime("앱 설치 · 설치 완료 · 저장"), W)).toBe("succeeded");
    expect(await playbookReadiness(db, cafe24Playbook)).toMatchObject({ verified: false, needsReverify: true });
    // 이탈 전 성공은 바뀐 화면을 검증하지 못했으므로 다시 센다: 1번 성공으로는 복귀하지 않는다
    await runPractice(db, runtime(), cafe24Playbook);
    expect(await playbookReadiness(db, cafe24Playbook)).toMatchObject({ streak: 1, verified: false, needsReverify: true });
    for (let i = 1; i < PRACTICE_STREAK_REQUIRED; i++) await runPractice(db, runtime(), cafe24Playbook);
    expect(await playbookReadiness(db, cafe24Playbook)).toMatchObject({ verified: true, needsReverify: false });
  });

  it("연습 기록에 비밀값·화면 원문이 남지 않는다(사유는 코드만)", async () => {
    const rt = runtime();
    rt.browser.outcome = () => ({ kind: "fatal", reason: "admin_error" });
    const run = await runPractice(db, rt, cafe24Playbook);
    expect(run).toMatchObject({ outcome: "FAILED", failedStep: "shop_connect", reason: "admin_error" });
    const secrets = await rt.vault.forJob({ sellerId: "practice", jobId: "x" });
    const all = JSON.stringify(await db.automationPracticeRun.findMany());
    expect(all).not.toContain(secrets.webhook_secret);
    expect(all).not.toContain(MATCHING_ADMIN);
  });
});
