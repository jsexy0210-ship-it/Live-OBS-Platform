import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 홈(MA-001): 맨 위 「오늘 처리할 일」(숫자·이동), 기간별 주문·결제·성장·상위 5 파트너스·구독 매출, 일부 통계가 실패해도 나머지는 보인다.
// 계정·파트너스·문의·주문은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `hm-cs-${run}@example.com`;
const topShop = `상위몰 ${run}`;
const pendingShop = `대기몰 ${run}`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.create({ data: { email, passwordHash, name: "상담", role: "CS" } });
  await db.seller.create({ data: { slug: `hm-p-${run}`, shopName: pendingShop, status: "PENDING" } });
  const seller = await db.seller.create({ data: { slug: `hm-t-${run}`, shopName: topShop, status: "ACTIVE", approvedAt: new Date() } });
  const user = await db.sellerUser.create({ data: { sellerId: seller.id, email: `hm-owner-${run}@example.com`, passwordHash, name: "대표", isOwner: true } });
  const inq = await db.platformInquiry.create({ data: { sellerId: seller.id, createdBySellerUserId: user.id, category: "OTHER", title: `홈 문의 ${run}`, lastMessageAt: new Date() } });
  await db.platformInquiryMessage.create({ data: { sellerId: seller.id, inquiryId: inq.id, authorType: "SELLER_USER", sellerUserId: user.id, body: "내용입니다." } });
  const grade = await db.memberGrade.create({ data: { sellerId: seller.id, displayName: "일반", sortOrder: 0, systemKey: "BASIC" } });
  const buyer = await db.buyerMember.create({
    data: { sellerId: seller.id, gradeId: grade.id, loginId: `hm${run}`, passwordHash: "x", name: "구매자", phone: `010${String(parseInt(run, 16)).padStart(8, "0").slice(-8)}`, broadcastNickname: "닉", ciHash: `ci-${run}`, identityVerifiedAt: new Date(), birthDate: new Date("1990-01-01") },
  });
  await db.order.create({ data: { sellerId: seller.id, orderNo: 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 123_456, paidAt: new Date() } });
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

test("오늘 처리할 일: 서버 숫자가 맨 위에 보이고, 누르면 조건이 걸린 목록으로 간다", async ({ page }) => {
  await login(page);
  const api = await (await page.request.get("/api/admin/today-tasks")).json();
  const count = (key: string) => api.items.find((i: { key: string }) => i.key === key).count;
  expect(count("signupPending")).toBeGreaterThan(0);
  expect(count("inquiryOpen")).toBeGreaterThan(0);
  const tasks = page.getByTestId("today-tasks");
  await expect(tasks.getByTestId("today-task-signupPending")).toContainText(`${count("signupPending")}건`);
  await expect(tasks.getByTestId("today-task-inquiryOpen")).toContainText(`${count("inquiryOpen")}건`);
  await expect(tasks.locator('[data-testid^="today-task-"]')).toHaveCount(7);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-home-1440.png", fullPage: true });

  await tasks.getByTestId("today-task-signupPending").click();
  await expect(page).toHaveURL(/\/admin\/partners\/applications/);
  await expect(page.getByRole("link", { name: pendingShop })).toBeVisible();
});

test("기간별 현황: 상위 5 파트너스에 결제된 쇼핑몰이 오르고, 기간 버튼이 바뀐다", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("button", { name: "최근 30일" })).toHaveAttribute("aria-pressed", "true");
  const row = page.getByTestId("top-seller-row").filter({ hasText: topShop });
  await expect(row).toContainText("123,456원");
  await expect(page.getByTestId("stats-orders")).toContainText("결제 금액");
  await expect(page.getByTestId("stats-subscriptions")).toContainText("월별 수납 매출");
  await page.getByRole("button", { name: "최근 7일" }).click();
  await expect(page.getByRole("button", { name: "최근 7일" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("top-seller-row").filter({ hasText: topShop })).toBeVisible();
});

test("한 통계가 실패해도 오늘 처리할 일과 나머지 통계는 그대로 보이고, 다시 시도하면 불러온다", async ({ page }) => {
  let fail = true;
  await page.route("**/api/admin/stats/orders**", (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' }) : route.continue()));
  await login(page);
  await expect(page.getByTestId("stats-orders")).toContainText("불러오지 못했습니다");
  await expect(page.getByTestId("today-task-signupPending")).toBeVisible();
  await expect(page.getByTestId("stats-top")).toContainText(topShop);
  fail = false;
  await page.getByTestId("stats-orders").getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("stats-orders")).toContainText("결제 금액");
});
