import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 PG 연결 상태(MA-031)·구독료 수납 현황(MA-032): 조회 화면(모든 마스터 역할). 폐기용 테스트 DB에만 데이터를 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `st-cs-${run}@example.com`;
const shopName = `정산몰 ${run}`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "상담", role: "CS" } });
  const seller = await db.seller.create({ data: { slug: `st-${run}`, shopName, status: "ACTIVE", approvedAt: new Date() } });
  const grade = await db.memberGrade.create({ data: { sellerId: seller.id, displayName: "일반", sortOrder: 0, systemKey: "BASIC" } });
  const buyer = await db.buyerMember.create({
    data: { sellerId: seller.id, gradeId: grade.id, loginId: `st${run}`, passwordHash: "x", name: "구매자", phone: `010${String(parseInt(run, 16)).padStart(8, "0").slice(-8)}`, broadcastNickname: "닉", ciHash: `ci-${run}`, identityVerifiedAt: new Date(), birthDate: new Date("1990-01-01") },
  });
  const order = await db.order.create({ data: { sellerId: seller.id, orderNo: 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 10000 } });
  await db.payment.create({ data: { sellerId: seller.id, orderId: order.id, provider: "nicepay", method: "CARD", status: "FAILED", amount: 10000, failureCode: "approve_timeout" } });
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
  const sub = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id } });
  const start = new Date(Date.now() - 86_400_000);
  const end = new Date(start.getTime() + 30 * 86_400_000);
  await db.subscriptionPayment.create({ data: { sellerId: seller.id, subscriptionId: sub.id, amount: 199_000, status: "PAID", periodStart: start, periodEnd: end, providerPaymentId: `fake-st-${run}`, paidAt: new Date() } });
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

test("PG 연결 상태: 게이트웨이 카드와 파트너스 표가 보이고, 이름으로 찾을 수 있다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/settlement/pg");
  await expect(page.getByTestId("pg-gateway")).toContainText("나이스페이");
  await expect(page.getByTestId("pg-gateway")).toContainText("시험 모드");
  await page.getByLabel("쇼핑몰 이름 또는 주소").fill(run);
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByTestId("pg-row")).toHaveCount(1);
  await expect(page.getByTestId("pg-row")).toContainText(shopName);
  await expect(page.getByTestId("pg-row")).toContainText("결제사 응답이 늦어 승인하지 못했습니다");
  await page.screenshot({ path: "tests/e2e/screenshots/admin-pg-1440.png" });
});

test("구독료 수납: 오늘 청구가 요약·일별 표에 보이고, 시작일이 종료일보다 늦으면 막힌다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/settlement/collection");
  await expect(page.getByTestId("collection-paid")).toContainText(/[1-9]\d*건 · [\d,]*199,000원|[1-9]\d*건 · [\d,]+원/);
  await expect(page.getByTestId("collection-row")).toHaveCount(1);
  await page.getByLabel("시작일").fill("2026-10-05");
  await page.getByLabel("종료일").fill("2026-10-01");
  await expect(page.getByText("시작일이 종료일보다 늦습니다.")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/admin-collection-1440.png" });
});
