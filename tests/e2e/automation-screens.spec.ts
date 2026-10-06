import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { cafe24Playbook } from "../../lib/server/automation/playbooks/cafe24";
import { PRACTICE_STREAK_REQUIRED } from "../../lib/server/automation/practice";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// 자동 연결 화면 SA-150~153 · MA-110·111. 폐기용 테스트 DB에 데모 파트너스(dev-seed)와 관리자를 쓴다.
// 서버는 BILLING_PROVIDER=fake · BILLING_KEY_SECRET(테스트용 임의값)이 필요하다(이 파일도 같은 값으로 카드를 넣는다).
// 결제는 가짜 결제 공급자라 실제 돈이 움직이지 않는다.
const password = process.env.E2E_PASSWORD ?? "";
const run = randomBytes(4).toString("hex");
const adminEmail = `auto-admin-${run}@example.com`;
const adminPw = randomBytes(12).toString("base64url");
const SHOP = "https://myshop.cafe24.com";
let db: PrismaClient;
let sellerId = "";

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const user = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com" }, select: { sellerId: true } });
  sellerId = user.sellerId;
  await db.automationJobEvent.deleteMany({ where: { sellerId } });
  await db.automationJob.deleteMany({ where: { sellerId } });
  await db.automationPayment.deleteMany({ where: { sellerId } });
  const card = { billingKeyCipher: sealBillingKey("fake-bk-e2e", sellerId), cardLabel: "테스트카드 1234" };
  const plan = await db.subscriptionPlan.upsert({ where: { code: "STANDARD" }, create: { code: "STANDARD", name: "월 구독", listPrice: 300000, salePrice: 199000 }, update: {} });
  await db.sellerSubscription.upsert({ where: { sellerId }, create: { sellerId, planId: plan.id, ...card }, update: card });
  const have = await db.automationPracticeRun.count({ where: { playbookId: cafe24Playbook.id, playbookVersion: cafe24Playbook.version } });
  if (have < PRACTICE_STREAK_REQUIRED)
    await db.automationPracticeRun.createMany({
      data: Array.from({ length: PRACTICE_STREAK_REQUIRED }, () => ({ playbookId: cafe24Playbook.id, playbookVersion: cafe24Playbook.version, outcome: "SUCCEEDED" as const, durationMs: 1, plannerCalls: 0, playbookActions: 13, costWon: 0, startedAt: new Date() })),
    });
  await db.platformAdmin.create({ data: { email: adminEmail, passwordHash: await hashPassword(adminPw), name: "운영", role: "READ_ONLY" } });
});
test.afterAll(async () => {
  const ids = (await db.platformAdmin.findMany({ where: { email: adminEmail }, select: { id: true } })).map((a) => a.id);
  await db.adminSession.deleteMany({ where: { adminId: { in: ids } } });
  await db.platformAdmin.deleteMany({ where: { email: adminEmail } });
  await db.$disconnect();
});

async function sellerLogin(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", password);
  await page.waitForURL((u) => !u.pathname.startsWith("/seller/login"));
}

test("파트너스: 주소 확인 → 결제 동의 5개 → 결제 → 진행 → 고객 확인 이어 하기 → 완료", async ({ page }) => {
  await sellerLogin(page);
  await page.goto("/seller/automation");
  await expect(page.getByTestId("automation-pay")).toHaveCount(0);
  // 지원 밖 쇼핑몰은 결제 전에 막는다
  await page.getByTestId("automation-url").fill("https://unknown-shop.example.com");
  await page.getByRole("button", { name: "연결 가능한지 확인하기" }).click();
  await expect(page.getByTestId("automation-unsupported")).toContainText("아직 자동 연결할 수 없는 쇼핑몰입니다");
  await page.getByTestId("automation-url").fill(SHOP);
  await page.getByRole("button", { name: "연결 가능한지 확인하기" }).click();
  await expect(page.getByTestId("automation-ok")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/automation-sa150-1440.png", fullPage: true });
  await page.getByTestId("automation-pay").click();
  await expect(page).toHaveURL(/\/seller\/automation\/pay/);
  await expect(page.getByTestId("pay-card")).toContainText("테스트카드 1234");
  const submit = page.getByTestId("pay-submit");
  await expect(submit).toBeDisabled();
  for (let i = 0; i < 5; i++) {
    await page.getByTestId(`pay-check-${i}`).check();
    if (i < 4) await expect(submit).toBeDisabled();
  }
  await expect(submit).toBeEnabled();
  await page.screenshot({ path: "tests/e2e/screenshots/automation-sa151-1440.png", fullPage: true });
  await submit.click();
  await expect(page).toHaveURL(/\/seller\/automation\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("job-status")).toContainText("결제 확인됨");
  const job = await db.automationJob.findFirstOrThrow({ where: { sellerId } });
  expect(job.status).toBe("QUEUED");
  expect(await db.automationPayment.count({ where: { sellerId, status: "PAID", amount: 110000 } })).toBe(1);
  // 안내 화면은 진행 중인 작업을 알려 준다
  await page.goto("/seller/automation");
  await expect(page.getByTestId("automation-open")).toBeVisible();
  // 고객 확인 대기: 할 일이 보이고 이어서 진행하기로 다시 대기열에 들어간다
  await db.automationJob.update({ where: { id: job.id }, data: { status: "NEEDS_CUSTOMER", customerAction: "TWO_FACTOR", actionDeadlineAt: new Date(Date.now() + 3600_000) } });
  await page.goto(`/seller/automation/${job.id}`);
  await expect(page.getByTestId("job-action")).toContainText("문자 인증을 마쳐 주십시오");
  await page.screenshot({ path: "tests/e2e/screenshots/automation-sa152-1440.png", fullPage: true });
  await page.getByRole("button", { name: "이어서 진행하기" }).click();
  await expect.poll(async () => (await db.automationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("QUEUED");
  // 취소 확인(시작 전)
  await page.getByRole("button", { name: "자동 설정 그만두기" }).click();
  await expect(page.getByTestId("cancel-confirm")).toContainText("아직 연결을 시작하지 않았습니다");
  await page.getByRole("button", { name: "계속 진행하기" }).click();
  await expect(page.getByTestId("cancel-confirm")).toHaveCount(0);
  // 완료는 작동 확인 증거가 있어야 보인다(없으면 진행 화면으로 안내)
  await db.automationJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", verifiedAt: new Date(), finishedAt: new Date() } });
  await page.goto(`/seller/automation/${job.id}/done`);
  await expect(page.getByTestId("done-ok")).toContainText("화면에 나오는 것까지 확인했습니다");
  await page.screenshot({ path: "tests/e2e/screenshots/automation-sa153-1440.png", fullPage: true });
});

test("마스터 관리자: 조회 전용 관리자가 목록 요약·필터·상세를 본다", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(adminEmail);
  await page.getByLabel("비밀번호").fill(adminPw);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/ops/automation");
  await expect(page.getByTestId("sum-done")).toBeVisible();
  await expect(page.getByTestId("automation-job").first()).toContainText("완료");
  await page.screenshot({ path: "tests/e2e/screenshots/automation-ma110-1920.png", fullPage: true });
  await page.getByRole("button", { name: "고객이 할 일 기다림", exact: true }).click();
  await expect(page.getByTestId("automation-job")).toHaveCount(0);
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await page.getByRole("link", { name: "상세" }).first().click();
  await expect(page.getByTestId("detail-status")).toContainText("완료");
  await page.screenshot({ path: "tests/e2e/screenshots/automation-ma111-1920.png", fullPage: true });
});
