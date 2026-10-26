import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 자동 연결 작업 상세(MA-111): 서버 흐름 표(단계별 완료·진행 중·대기)와 남은 시도·취소 요청 표시. 폐기용 테스트 DB에만 데이터.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `aj-ro-${run}@example.com`;
let db: PrismaClient;
let jobId = "";
let sellerId = "";
let paymentId = "";

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "조회", role: "READ_ONLY" } });
  const seller = await db.seller.create({ data: { slug: `aj-${run}`, shopName: `흐름몰 ${run}`, status: "ACTIVE", approvedAt: new Date() } });
  sellerId = seller.id;
  const now = new Date();
  const payment = await db.automationPayment.create({ data: { sellerId, amount: 110000, status: "PAID", idempotencyKey: `aj-${run}`, requestFingerprint: `aj-${run}`, consentNoticeVersion: "synthetic", consentAgreedAt: now } });
  paymentId = payment.id;
  jobId = (await db.automationJob.create({ data: { sellerId, paymentId, obsTargetKey: `aj-${run}`, status: "RUNNING", stepIndex: 2, attempts: 2, maxAttempts: 5, startedAt: new Date(now.getTime() - 600_000), cancelRequestedAt: now, leaseOwner: `aj-${run}`, leaseExpiresAt: new Date(now.getTime() + 3_600_000) } })).id;
});
test.afterAll(async () => {
  if (jobId) await db.automationJob.deleteMany({ where: { id: jobId } });
  if (paymentId) await db.automationPayment.deleteMany({ where: { id: paymentId } });
  if (sellerId) await db.seller.deleteMany({ where: { id: sellerId } });
  const admin = await db.platformAdmin.findUnique({ where: { email } });
  if (admin) {
    await db.adminSession.deleteMany({ where: { adminId: admin.id } });
    await db.platformAdmin.deleteMany({ where: { id: admin.id } });
  }
  await db.$disconnect();
});

async function login(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("작업 상세: 흐름 표가 단계마다 완료·진행 중·대기를 보이고, 남은 시도·취소 요청이 보인다", async ({ page }) => {
  await login(page);
  await page.goto(`/admin/ops/automation/${jobId}`);
  const rows = page.getByTestId("flow-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText("완료");
  await expect(rows.nth(1)).toContainText("완료");
  await expect(rows.nth(2)).toContainText("진행 중");
  await expect(rows.nth(3)).toContainText("대기");
  await expect(rows.nth(4)).toContainText("대기");
  await expect(page.getByText("남은 시도 3번")).toBeVisible();
  await expect(page.getByTestId("cancel-requested")).toBeVisible();
  for (const w of [1440, 1024]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`/admin/ops/automation/${jobId}`);
    await expect(page.getByTestId("job-flow")).toBeVisible();
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/ma-111-${w}.png`, fullPage: true });
  }
});
