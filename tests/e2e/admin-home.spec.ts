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
const suEmail = `hm-su-${run}@example.com`;
const topShop = `상위몰 ${run}`;
const pendingShop = `대기몰 ${run}`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email, passwordHash, name: "상담", role: "CS" },
      { email: suEmail, passwordHash, name: "최고", role: "SUPER_ADMIN" },
    ],
  });
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

async function login(page: Page, who = email) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(who);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function expectChartPlacement(page: Page, width: number) {
  await expect(page.locator(".ma-home-line svg")).toBeVisible();
  const revenue = await page.getByTestId("stats-orders").boundingBox();
  const orders = await page.getByTestId("stats-order-series").boundingBox();
  const grid = await page.locator(".ma-home-grid").boundingBox();
  const chart = await page.locator(".ma-home-line svg").boundingBox();
  expect(revenue && orders && grid && chart).toBeTruthy();
  expect(chart!.width).toBeGreaterThan(revenue!.width - 70);
  if (width === 1440) {
    expect(revenue!.width).toBeGreaterThan(orders!.width * 1.9);
    expect(Math.abs(revenue!.y - orders!.y)).toBeLessThan(1);
    expect(orders!.x).toBeGreaterThan(revenue!.x + revenue!.width);
  } else {
    expect(Math.abs(revenue!.width - grid!.width)).toBeLessThan(1);
    expect(orders!.y).toBeGreaterThanOrEqual(revenue!.y + revenue!.height);
    if (width === 390) expect(Math.abs(revenue!.width - orders!.width)).toBeLessThan(1);
  }
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
  await expect(tasks.locator('[data-testid^="today-task-"]')).toHaveCount(8);
  await expect(tasks.getByTestId("today-task-inquiryOpen")).toContainText("파트너스 문의");
  await expect(page.getByTestId("today-tasks-at")).toContainText("집계");
  await expect(page.getByTestId("infra-card")).toHaveCount(0); // 인프라 · 비용 카드는 최고관리자에게만 보인다
  await expect(page.locator(".ma-home-kpis > section")).toHaveCount(6);
  await expect(page.getByTestId("home-operations")).toContainText("실시간 감시");
  await expect(page.getByTestId("home-db-metrics")).toHaveCount(0);
  await expect(page.getByTestId("home-admin-activity")).toHaveCount(0);
  await expect(page.locator(".ma-home-grid")).toHaveCSS("grid-template-columns", /^(\d+(\.\d+)?px) (\d+(\.\d+)?px) (\d+(\.\d+)?px)$/);
  await expectChartPlacement(page, 1440);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-home-1440.png", fullPage: true });
  for (const w of [1024, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.reload();
    await expect(page.getByTestId("today-tasks")).toBeVisible();
    await expect(page.locator(".ma-home-grid")).toHaveCSS("grid-template-columns", w === 390 ? /^(\d+(\.\d+)?px)$/ : /^(\d+(\.\d+)?px) (\d+(\.\d+)?px)$/);
    await expectChartPlacement(page, w);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `tests/e2e/screenshots/admin-home-${w}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();

  for (const [id, href] of [["sellers", "/admin/partners"], ["live", "/admin/ops/live"], ["orders", "/admin/ops/access"], ["subscription", "/admin/billing/subscriptions"], ["grace", "/admin/billing/subscriptions"]]) {
    const link = page.getByTestId(`home-kpi-${id}`).getByRole("heading").getByRole("link");
    await expect(link).toHaveAttribute("href", href);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await page.goto("/admin");
    await expect(page.getByTestId("today-tasks")).toBeVisible();
  }
  await expect(page.getByTestId("home-kpi-revenue").getByRole("link")).toHaveCount(0);

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
  await expect(page.getByTestId("stats-subscriptions")).toContainText("월별 받은 구독료");
  await expect(page.getByTestId("stats-order-series")).toContainText("결제된 주문");
  await expect(page.getByTestId("stats-growth")).toContainText("가입 신청");
  await expect(page.getByTestId("home-month-billing")).toContainText("청구 · 결제 내역");
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

test("빈 파트너스 안내와 요약 오류는 데모 수치 없이 독립적으로 보인다", async ({ page }) => {
  let fail = false;
  await page.route("**/api/admin/dashboard", (route) => route.fulfill({
    status: fail ? 500 : 200,
    contentType: "application/json",
    body: fail ? '{"error":"x"}' : JSON.stringify({ at: new Date().toISOString(), sellers: { total: 0, PENDING: 0, ACTIVE: 0, SUSPENDED: 0, REJECTED: 0, CLOSED: 0 }, liveBroadcasts: 0, ordersToday: { created: 0, paid: 0, paidAmount: 0 }, subscriptions: { trial: 0, paid: 0, charging: 0, grace: 0, expired: 0 } }),
  }));
  await login(page);
  await expect(page.getByTestId("dash-sellers-total")).toHaveText("0곳");
  await expect(page.getByTestId("home-kpi-sellers")).toContainText("아직 파트너스가 없습니다");
  await expect(page.getByTestId("stats-top")).toContainText(topShop);
  fail = true;
  await page.getByRole("button", { name: "새로 고침", exact: true }).click();
  await expect(page.getByTestId("home-kpi-sellers")).toContainText("불러오지 못했습니다");
  await expect(page.getByTestId("stats-top")).toContainText(topShop);
  await expect(page.getByTestId("home-kpi-sellers")).not.toContainText("184");
});

test("최고관리자: 오늘 처리할 일 아래에 인프라 · 비용 요약 카드가 보이고 누르면 인프라 · 비용 화면으로 간다", async ({ page }) => {
  await login(page, suEmail);
  const card = page.getByTestId("infra-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("infra-card-cost")).toBeVisible();
  await expect(card.getByTestId("infra-card-warnings")).toBeVisible();
  await expect(page.getByTestId("home-db-metrics")).toContainText("DB 연결");
  await expect(page.getByTestId("home-admin-activity")).toContainText("로그 추적 전체");
  const activity = await (await page.request.get("/api/admin/audit-logs?limit=5&actorType=PLATFORM_ADMIN")).json();
  for (const row of activity.logs) {
    const actor = page.getByTestId("home-admin-activity").locator(`td:nth-child(2) a[href="/admin/logs/${row.id}"]`);
    await expect(actor).toHaveText(row.actorId ? `마스터 관리자 · 식별자 ${row.actorId}` : "마스터 관리자 · 식별자 기록 없음");
  }
  const above = await page.getByTestId("today-tasks").boundingBox();
  const at = await card.boundingBox();
  expect(at!.y).toBeGreaterThan(above!.y); // 「오늘 처리할 일」 바로 아래
  await page.screenshot({ path: "tests/e2e/screenshots/admin-home-infra-1440.png", fullPage: true });
  for (const w of [1024, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.reload();
    await expect(page.getByTestId("infra-card")).toBeVisible();
    await expect(page.getByTestId("infra-card-cost")).toBeVisible();
    await page.screenshot({ path: `tests/e2e/screenshots/admin-home-infra-${w}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await card.getByRole("link").click();
  await expect(page).toHaveURL(/\/admin\/ops\/infra$/);
});
