import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 환불 승인(MA-027): 결제 공급자에 결제 취소를 요청한다. 가짜 결제 공급자(돈 이동 없음)가 필요해
// 테스트 모드 서버(OBS_TEST_MODE=1, BILLING_PROVIDER=fake, BILLING_KEY_SECRET 32자 이상 테스트용 값)에서만 돈다(playwright.config.ts의 testmode 프로젝트).
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `rfa-super-${run}@example.com`;
const name = `승인몰 ${run}`;
let refundId = "";
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "대표", role: "SUPER_ADMIN" } });
  const seller = await db.seller.create({ data: { slug: `rfa-${run}`, shopName: name, status: "ACTIVE", approvedAt: new Date() } });
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
  const sub = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id } });
  const start = new Date(Date.now() - 86_400_000);
  const payment = await db.subscriptionPayment.create({
    data: { sellerId: seller.id, subscriptionId: sub.id, amount: 199_000, status: "PAID", periodStart: start, periodEnd: new Date(start.getTime() + 30 * 86_400_000), providerPaymentId: `fake-pay-${run}`, paidAt: new Date() },
  });
  refundId = (await db.subscriptionRefund.create({ data: { sellerId: seller.id, paymentId: payment.id, amount: 199_000, source: "ADMIN", reason: `중복 결제 ${run}` } })).id;
});
test.afterAll(async () => {
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

test("최고관리자: 확인 체크 후 승인하면 환불 완료로 바뀌고 DB에 반영되며, 끝난 환불에는 승인 영역이 없다", async ({ page }) => {
  await login(page);
  await page.goto(`/admin/billing/refunds/${refundId}`);
  await page.getByLabel("내용을 확인했고 환불을 승인합니다").check();
  await page.getByRole("button", { name: "환불 승인하고 카드 결제 취소" }).click();
  await expect(page.getByText("199,000원을 환불했습니다.")).toBeVisible();
  await expect(page.getByTestId("refund-status")).toContainText("환불 완료");
  await expect(page.getByRole("button", { name: /환불 실행/ })).toHaveCount(0);
  const after = await db.subscriptionRefund.findUniqueOrThrow({ where: { id: refundId } });
  expect(after.status).toBe("REFUNDED");
  expect(after.refundedAt).not.toBeNull();
});
