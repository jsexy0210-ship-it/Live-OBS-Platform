import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-005 쇼핑몰 통합으로 바꾸기: 개발 서버(npx next dev -p 3101, BILLING_PROVIDER=fake·BILLING_KEY_SECRET·BUSINESS_STATUS_PROVIDER=fake)에서
// 오버레이 전용 → 통합(사업자·정산 정보 저장 + 차액 결제) → 오버레이 전용 변경 신청·취소를 실제 API로 확인한다. 돈 이동 없음(가짜 결제).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const OWNER = "demo-overlay-owner@example.com";
const DAY = 86_400_000;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function withDb<T>(fn: (db: PrismaClient, sellerId: string) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: OWNER, isOwner: true }, select: { sellerId: true } });
    return await fn(db, owner.sellerId);
  } finally {
    await db.$disconnect();
  }
}

let original: { trialEndsAt: Date | null; planId: string | null } | undefined;
async function reset() {
  await withDb(async (db, sellerId) => {
    const s = await db.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { trialEndsAt: true, planId: true } });
    original ??= s;
    await db.$transaction([
      db.subscriptionPayment.deleteMany({ where: { sellerId } }),
      db.sellerSubscription.deleteMany({ where: { sellerId } }),
      db.sellerIntegrationProfile.deleteMany({ where: { sellerId } }),
    ]);
    const overlay = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: new Date(Date.now() - DAY), planId: overlay.id } });
  });
}
test.afterAll(async () => {
  if (!original) return;
  const o = original;
  await withDb(async (db, sellerId) => {
    await db.$transaction([
      db.subscriptionPayment.deleteMany({ where: { sellerId } }),
      db.sellerSubscription.deleteMany({ where: { sellerId } }),
      db.sellerIntegrationProfile.deleteMany({ where: { sellerId } }),
    ]);
    await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: o.trialEndsAt, planId: o.planId } });
  });
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("오버레이 전용: 사업자·정산 정보를 채워 쇼핑몰 통합으로 바꾸고, 다시 오버레이 전용 변경을 신청·취소한다", async ({ page }) => {
  await reset();
  await page.goto("/seller/login?next=%2Fseller%2Fsubscription");
  await submitSellerLogin(page, OWNER, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/subscription$/);
  // 카드 등록(가짜 결제) → 결제한 기간 중간으로 맞춘다(남은 7일)
  const card = await page.evaluate(async () => (await fetch("/api/seller/subscription/card", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authKey: `test-${crypto.randomUUID()}` }) })).status);
  expect(card).toBe(200);
  await withDb((db, sellerId) =>
    db.sellerSubscription.update({ where: { sellerId }, data: { currentPeriodStart: new Date(Date.now() - 23 * DAY), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextChargeAt: new Date(Date.now() + 7 * DAY) } }),
  );
  const expectedAmount = await withDb(async (db, sellerId) => {
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId }, select: { subscribedAt: true, regularPrice: true, legacyPrice: true } });
    expect(sub.legacyPrice).toBeNull();
    const plans = await db.subscriptionPlan.findMany({ where: { code: { in: ["OVERLAY_ONLY", "INTEGRATED"] } }, include: { priceChanges: { where: { changedAt: { lte: sub.subscribedAt } }, orderBy: { changedAt: "desc" }, take: 1 } } });
    const prices = Object.fromEntries(plans.map((plan) => { const price = plan.priceChanges[0] ?? plan; return [plan.code, sub.regularPrice ? price.listPrice : price.salePrice]; }));
    // 원 단위 절사와 30일 중 남은 7일은 독립 기대값이며 제품 계산 함수를 호출하지 않는다.
    const amount = Math.floor((prices.INTEGRATED - prices.OVERLAY_ONLY) * 7 / 30);
    expect(amount).toBeGreaterThan(0);
    return amount;
  });
  const quoteText = `지금 결제할 금액은 ${expectedAmount.toLocaleString("ko-KR")}원입니다 · 남은 기간 7일`;

  // 메뉴 「쇼핑몰 통합 전환」에서 들어온다
  await page.goto("/seller/subscription");
  const previewRequest = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/seller/subscription/plan/preview" && r.method() === "GET");
  await page.getByRole("link", { name: "쇼핑몰 통합 전환", exact: true }).click();
  const previewResponse = await (await previewRequest).response();
  expect(previewResponse?.status()).toBe(200);
  const preview = await previewResponse!.json();
  expect(preview.plans.find((p: { planCode: string }) => p.planCode === "INTEGRATED").change).toMatchObject({ ok: false, reason: "profile_incomplete", quote: { chargeNow: expectedAmount, remainingDays: 7, periodDays: 30 } });
  await expect(page).toHaveURL(/\/seller\/settings\/upgrade$/);
  await expect(page.getByRole("heading", { name: "쇼핑몰 통합으로 바꾸기" })).toBeVisible();
  const go = page.getByRole("button", { name: "쇼핑몰 통합으로 바꾸기" });
  await expect(go).toBeDisabled();
  await expect(page.getByText("필수 항목을 모두 채우면 버튼이 켜집니다")).toBeVisible();
  await expect(page.locator(".up-expl")).toContainText(quoteText);
  await shot(page, "SA-005-empty");

  await page.getByLabel("상호").fill("달빛상회");
  await page.getByLabel("대표자명").fill("김달빛");
  await page.getByLabel("사업자등록번호").fill("123-45-67891");
  await page.getByLabel("사업장 주소").fill("서울 중구 세종대로 110");
  await page.getByLabel("은행").selectOption("국민은행");
  await page.getByLabel("계좌번호").fill("12345678901234");
  await page.getByLabel("예금주").fill("김달빛");
  await expect(go).toBeEnabled();

  // 개업일자가 없는 계정: 조회가 먼저 개업일자를 요구한다
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page.locator(".msg-neg")).toContainText("개업일자를 입력해 주십시오");
  await page.getByLabel("개업일자").fill("2020-01-01");
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page.getByRole("button", { name: "조회됨" })).toBeVisible();
  await shot(page, "SA-005-filled");

  // 정보를 채우기 전에도 서버 견적이 와서 차액과 산식이 보이고, 한 번 눌러 결제된다(금액은 서버 chargeNow와 같을 때만 결제)
  await expect(page.locator(".up-expl")).toContainText(quoteText);
  const savedProfile = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/seller/integration-profile" && r.request().method() === "PUT");
  const freshQuote = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/seller/subscription/plan/preview" && r.request().method() === "GET");
  const applied = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/seller/subscription/plan" && r.request().method() === "POST");
  await go.click();
  expect((await savedProfile).status()).toBe(200);
  const fresh = await freshQuote;
  expect(fresh.status()).toBe(200);
  const freshPreview = await fresh.json();
  expect(freshPreview.plans.find((p: { planCode: string }) => p.planCode === "INTEGRATED").change).toMatchObject({ ok: true, chargeNow: expectedAmount, remainingDays: 7 });
  const appliedResponse = await applied;
  expect(appliedResponse.status()).toBe(200);
  expect(appliedResponse.request().postDataJSON()).toEqual({ planCode: "INTEGRATED", expectedAmount });
  expect(await appliedResponse.json()).toMatchObject({ ok: true, applied: "now", charged: expectedAmount, planCode: "INTEGRATED" });
  await expect(page.getByRole("status").filter({ hasText: "쇼핑몰 통합으로 바꿨습니다" })).toBeVisible();
  await shot(page, "SA-005-done");
  await withDb(async (db, sellerId) => {
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId }, select: { plan: { select: { code: true } } } });
    expect(sub.plan.code).toBe("INTEGRATED");
    const p = await db.sellerIntegrationProfile.findUniqueOrThrow({ where: { sellerId } });
    expect(p.accountLast4).toBe("1234");
    expect(p.accountCipher).not.toContain("12345678901234");
  });

  // 통합 → 오버레이 전용 변경 신청 → 예정 안내 → 취소
  await page.goto("/seller/settings/upgrade");
  await expect(page.getByText("적용되면 ONQ 스토어에서 새 주문은 받지 않습니다")).toBeVisible();
  await shot(page, "SA-005-down");
  await page.getByRole("button", { name: "오버레이 전용으로 변경 신청" }).click();
  await expect(page.getByRole("dialog")).toContainText("오버레이 전용으로 바꾸시겠습니까?");
  await page.getByRole("dialog").getByRole("button", { name: "변경 신청" }).click();
  await expect(page.getByText("오버레이 전용으로 바뀔 예정입니다")).toBeVisible();
  await shot(page, "SA-005-pending");
  await page.getByRole("button", { name: "변경 취소", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("변경을 취소하시겠습니까?");
  await page.getByRole("dialog").getByRole("button", { name: "변경 취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "오버레이 전용으로 변경 신청" })).toBeVisible();
});
