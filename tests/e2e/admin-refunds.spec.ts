import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 환불 요청 목록·처리(MA-026·027): 목록 탭·사유 문구, 거절(사유 필수), 권한(승인은 최고관리자만, 거절은 운영까지, CS·조회 전용은 보기만).
// 승인(결제 취소 요청)은 가짜 결제 공급자가 필요해 테스트 모드 서버용 admin-refund-approve.spec.ts에서 확인한다.
// 계정·파트너스·청구는 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { super: `rf-super-${run}@example.com`, ops: `rf-ops-${run}@example.com`, cs: `rf-cs-${run}@example.com` };
const shop = (k: string) => `환불몰 ${k} ${run}`;
const ids: Record<string, string> = {};
let db: PrismaClient;

async function refund(key: string, data: { reason: string; source?: "SYSTEM" | "ADMIN"; amount?: number }) {
  const seller = await db.seller.create({ data: { slug: `rf-${key}-${run}`, shopName: shop(key), status: "ACTIVE", approvedAt: new Date() } });
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
  const sub = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id } });
  const start = new Date(Date.now() - 86_400_000);
  const payment = await db.subscriptionPayment.create({
    data: { sellerId: seller.id, subscriptionId: sub.id, amount: 199_000, status: "PAID", periodStart: start, periodEnd: new Date(start.getTime() + 30 * 86_400_000), providerPaymentId: `fake-pay-${key}-${run}`, paidAt: new Date() },
  });
  const r = await db.subscriptionRefund.create({ data: { sellerId: seller.id, paymentId: payment.id, amount: data.amount ?? 199_000, source: data.source ?? "ADMIN", reason: data.reason } });
  ids[key] = r.id;
}

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.super, passwordHash, name: "대표", role: "SUPER_ADMIN" },
      { email: emails.ops, passwordHash, name: "운영", role: "OPERATIONS" },
      { email: emails.cs, passwordHash, name: "상담", role: "CS" },
    ],
  });
  await refund("auto", { reason: "paid_after_cancel", source: "SYSTEM" });
  await refund("rej", { reason: `중복 결제 ${run}` });
  await refund("ops", { reason: `운영 거절 ${run}` });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, email: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("목록: 승인 대기 탭에 요청이 보이고, 시스템이 만든 요청의 사유는 「해지 뒤 결제됨」으로 바뀐다", async ({ page }) => {
  await login(page, emails.cs);
  await page.goto("/admin/billing/refunds");
  const auto = page.getByTestId("refund-row").filter({ hasText: shop("auto") });
  await expect(auto).toContainText("해지 뒤 결제됨");
  await expect(auto).toContainText("자동 요청");
  await expect(auto).toContainText("처리 대기");
  await expect(page.getByRole("button", { name: /^처리 대기 \d+$/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^환불 완료/ }).click();
  await expect(page.getByTestId("refund-row").filter({ hasText: shop("auto") })).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-refunds-1440.png" });
});

test("최고관리자: 거절은 사유가 있어야 하고, 거절하면 상태와 DB에 반영된다. 승인 영역은 확인 체크 전에는 막혀 있다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto(`/admin/billing/refunds/${ids.rej}`);
  await expect(page.getByTestId("refund-status")).toContainText("처리 대기");
  await expect(page.getByRole("button", { name: "환불 승인하고 카드 결제 취소" })).toBeDisabled();
  await page.getByLabel("내용을 확인했고 환불을 승인합니다").check();
  await expect(page.getByRole("button", { name: "환불 승인하고 카드 결제 취소" })).toBeEnabled();
  await page.getByRole("button", { name: "거절", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "거절", exact: true })).toBeDisabled();
  await dialog.getByLabel("거절 사유").fill("정책 밖 요청입니다.");
  await dialog.getByRole("button", { name: "거절", exact: true }).click();
  await expect(page.getByText("환불 요청을 거절했습니다.")).toBeVisible();
  await expect(page.getByTestId("refund-status")).toContainText("거절");
  const after = await db.subscriptionRefund.findUniqueOrThrow({ where: { id: ids.rej } });
  expect(after.status).toBe("REJECTED");
  expect(after.decisionNote).toBe("정책 밖 요청입니다.");
});

test("운영 담당: 거절은 할 수 있지만 승인은 못 한다(최고관리자 전용 안내)", async ({ page }) => {
  await login(page, emails.ops);
  await page.goto(`/admin/billing/refunds/${ids.ops}`);
  await expect(page.getByText("승인은 최고관리자만 할 수 있습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: /환불 실행/ })).toHaveCount(0);
  await page.getByRole("button", { name: "거절", exact: true }).click();
  await page.getByRole("dialog").getByLabel("거절 사유").fill("운영 판단으로 거절합니다.");
  await page.getByRole("dialog").getByRole("button", { name: "거절", exact: true }).click();
  await expect(page.getByTestId("refund-status")).toContainText("거절");
});

test("CS: 목록·상세는 볼 수 있지만 승인·거절 버튼이 없다", async ({ page }) => {
  await login(page, emails.cs);
  await page.goto(`/admin/billing/refunds/${ids.auto}`);
  await expect(page.getByTestId("refund-status")).toContainText("처리 대기");
  await expect(page.getByText("승인은 최고관리자만 할 수 있습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "거절", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /환불 실행/ })).toHaveCount(0);
});
