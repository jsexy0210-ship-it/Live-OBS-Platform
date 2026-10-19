import { expect, test, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";
import { okConfirm } from "./shopConfirm";

// API 원 전체 배열 계약은 독립 소스 대조로 확인한다. 이 시험의 목록·변경 응답은 고유 합성 mock만 쓴다.
const run = randomBytes(6).toString("hex");
const email = `remaining-${run}@example.com`;
const password = randomBytes(12).toString("base64url");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = `tests/e2e/screenshots/current-shell-${sha}`;
const names = (prefix: string) => Array.from({ length: 23 }, (_, i) => `${prefix} ${String(i).padStart(2, "0")}`);
let db: PrismaClient;
let adminId: string | undefined;

test.beforeAll(async ({}, info) => {
  expect(process.env.CI).toBe("true");
  expect(["e2e-smoke", "e2e-full"]).toContain(process.env.GITHUB_JOB);
  expect(process.env.NODE_ENV).not.toBe("production");
  expect(info.config.workers).toBe(1);
  const url = assertTestDatabaseUrl(process.env.DATABASE_URL);
  expect(new URL(url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(new URL(url).pathname).toBe("/live_obs_test");
  const base = new URL(String(info.project.use.baseURL));
  expect(base.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(base.port).toBe("3100");
  expect(process.env.E2E_PASSWORD).toBeTruthy();
  db = new PrismaClient({ datasources: { db: { url } } });
  adminId = (await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "목록 합성 검수", role: "SUPER_ADMIN" } })).id;
  mkdirSync(evidence, { recursive: true });
});
test.afterAll(async () => {
  if (!db) return;
  try {
    if (adminId) {
      await db.adminSession.deleteMany({ where: { adminId } });
      await db.platformAdmin.deleteMany({ where: { id: adminId } });
    }
  } finally { await db.$disconnect(); }
});
async function login(page: Page, admin = false) {
  await page.goto(admin ? "/admin/login" : "/seller/login");
  if (admin) {
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호").fill(password);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
  } else {
    await submitSellerLogin(page, "demo-owner@example.com", process.env.E2E_PASSWORD!);
    await expect(page).toHaveURL(/\/seller$/);
  }
}
async function pages(page: Page, rows: Locator, text: string, labels: string[], navName: string) {
  const nav = page.getByRole("navigation", { name: navName, exact: true });
  const seen: string[] = [];
  for (let n = 1; n <= 3; n++) {
    await expect(rows).toHaveCount(n < 3 ? 10 : 3);
    await expect(rows.locator(text)).toHaveText(labels.slice((n - 1) * 10, n * 10));
    await expect(nav.getByRole("button", { name: `${n}페이지`, exact: true })).toHaveAttribute("aria-current", "page");
    seen.push(...await rows.locator(text).allTextContents());
    if (n < 3) await nav.getByRole("button", { name: "다음", exact: true }).click();
  }
  expect(seen).toEqual(labels); expect(new Set(seen).size).toBe(23);
  await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await expect(nav.getByRole("button", { name: "마지막", exact: true })).toBeDisabled();
  await nav.getByRole("button", { name: "이전", exact: true }).click();
  await expect(rows.locator(text)).toHaveText(labels.slice(10, 20));
  await nav.getByRole("button", { name: "처음", exact: true }).click();
  await expect(rows.locator(text)).toHaveText(labels.slice(0, 10));
  await expect(nav.getByRole("button", { name: "이전", exact: true })).toBeDisabled();
}
async function capture(page: Page, id: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const nav = page.getByRole("navigation", { name: /페이지 이동/ }).last();
    await expect(nav).toBeVisible();
    const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null, scrollWidth: document.documentElement.scrollWidth }));
    const name = `${id}-remaining10-${width}`;
    await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
    writeFileSync(`${evidence}/${name}.json`, JSON.stringify({ actualGitSha: sha, route: page.url(), state: "first-page-owned-mock", fixture: run, browserZoom: "UNVERIFIED", metrics }, null, 2));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("MA043: 전체 5 KPI·순서를 유지하고 23개를 10/10/3으로 접근한다", async ({ page }) => {
  const labels = names("합성 실지급");
  const items = labels.map((shopName, i) => ({ sellerId: `${run}-pay-${i}`, shopName, slug: `pay-${i}`, status: "ACTIVE", enabledAt: new Date().toISOString(), earnTiming: "ON_PAYMENT", outstanding: { amount: 1000, members: 2 }, monthTradingAmount: 2000, balanceRatioPercent: 50, maxConfiguredRewardRatePercent: 5, payoutToday: { succeeded: 1, failed: 0, observedFailed: 0, uncertainModeFailed: 0, undatedFailed: 0 }, manualGrant30DaysAmount: 0, signals: { balanceRatio: { thresholdPercent: 25, state: "WARN" }, payoutFailure: { state: "OK" }, manualConcentration: { state: "NOT_DEFINED" } } }));
  let data = items;
  await page.route("**/api/admin/ops/live-payout-sellers", route => { expect(route.request().method()).toBe("GET"); return route.fulfill({ json: { at: new Date().toISOString(), items: data } }); });
  await login(page, true); await page.goto("/admin/ops/rewards");
  await pages(page, page.getByTestId("payout-row"), "td:first-child > b", labels, "실지급 파트너스 페이지 이동");
  await expect(page.getByTestId("pay-count")).toHaveText("23곳");
  await expect(page.getByTestId("pay-amount")).toHaveText("23,000원");
  await expect(page.getByTestId("pay-members")).toHaveText("46명");
  await expect(page.getByTestId("pay-month-net")).toHaveText("46,000원");
  await expect(page.getByTestId("pay-ratio-warn")).toHaveText("23곳");
  await capture(page, "MA043");
  data = items.slice(0, 10); await page.reload(); await expect(page.getByTestId("payout-row")).toHaveCount(10);
  await expect(page.getByRole("navigation", { name: "실지급 파트너스 페이지 이동" })).toHaveCount(0);
  data = []; await page.reload(); await expect(page.getByText("실지급을 켠 파트너스가 없습니다.")).toBeVisible();
});
test("MA061: 네 역할 전체 요약·원 배열 순서와 빈/한 쪽 경계를 보존한다", async ({ page }) => {
  const labels = names("합성 관리자");
  const items = labels.map((name, i) => ({ id: `${run}-account-${i}`, name, email: `mock-${i}@example.com`, role: i === 0 ? "SUPER_ADMIN" : ["OPERATIONS", "CS", "READ_ONLY"][(i - 1) % 3], status: "ACTIVE", lastLoginAt: null, createdAt: new Date().toISOString() }));
  let data = items;
  await page.route("**/api/admin/admins", route => { expect(route.request().method()).toBe("GET"); return route.fulfill({ json: { admins: data } }); });
  await login(page, true); await page.goto("/admin/accounts");
  await pages(page, page.getByTestId("account-row"), "td:first-child", labels, "관리자 계정 페이지 이동");
  for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"]) await expect(page.getByTestId(`role-count-${role}`)).toHaveText(`${items.filter(a => a.role === role).length}명`);
  await expect(page.getByText("23명", { exact: true })).toBeVisible(); await capture(page, "MA061");
  data = items.slice(0, 10); await page.reload(); await expect(page.getByTestId("account-row")).toHaveCount(10);
  await expect(page.getByRole("navigation", { name: "관리자 계정 페이지 이동" })).toHaveCount(0);
  data = []; await page.reload(); await expect(page.getByTestId("account-row")).toHaveCount(0);
});
test("SA017: 고객 실제 GET 없이 전체 대기 합계·순서와 10개 표시를 확인한다", async ({ page }) => {
  const labels = names("합성 재입고");
  const items = labels.map((name, i) => ({ productId: `${run}-restock-${i}`, name, soldOut: true, waiting: 3, queued: 2, sent: 1, nextNotifyAt: null, lastNotifiedAt: null }));
  let data = items;
  await page.route("**/api/seller/restock-alerts", route => { expect(route.request().method()).toBe("GET"); return route.fulfill({ json: { items: data } }); });
  await login(page); await page.goto("/seller/products/restock-alerts");
  await pages(page, page.getByTestId("restock-row"), "td:first-child > a", labels, "재입고 알림 페이지 이동");
  await expect(page.getByText("재고를 기다리는 구매자 69명 · 신청한 구매자 정보는 표시하지 않습니다")).toBeVisible();
  await capture(page, "SA017");
  data = items.slice(0, 10); await page.reload(); await expect(page.getByTestId("restock-row")).toHaveCount(10);
  await expect(page.getByRole("navigation", { name: "재입고 알림 페이지 이동" })).toHaveCount(0);
  data = []; await page.reload(); await expect(page.getByText("재입고 알림 신청이 없습니다")).toBeVisible();
});
test("SA035: 필터 후 전 접근·1쪽 복귀와 전체 선택 23개의 일괄 범위를 보존한다", async ({ page }) => {
  const labels = names("합성 쿠폰");
  const now = Date.now();
  const coupons = labels.map((name, i) => ({ id: `${run}-coupon-${i}`, name, issueMethod: "DOWNLOAD", code: null, benefit: "AMOUNT", value: 1000, maxDiscount: null, minOrderAmount: 0, startsAt: new Date(now - 86400000).toISOString(), endsAt: new Date(now + 86400000).toISOString(), validDays: null, issueLimit: null, issuedCount: 1, productIds: [], excludeDiscounted: false, allowWithReward: true, isActive: true, benefitText: "1,000원 할인", status: "live", soldOut: false, used: 1, discountTotal: 1000 }));
  const changed: string[] = [];
  await page.route("**/api/seller/coupons", route => { expect(route.request().method()).toBe("GET"); return route.fulfill({ json: { coupons, summary: { live: 23, monthUsed: 23, monthDiscount: 23000, monthCouponOrderRate: 50, expiringSoon: 23 }, grades: [], products: [], canEdit: true } }); });
  await page.route("**/api/seller/coupons/*", route => { expect(route.request().method()).toBe("PATCH"); const id = new URL(route.request().url()).pathname.split("/").pop()!; expect(coupons.some(c => c.id === id)).toBe(true); expect(route.request().postDataJSON()).toEqual({ isActive: false }); changed.push(id); return route.fulfill({ json: {} }); });
  await login(page); await page.goto("/seller/coupons");
  const rows = page.locator(".cp-tbl tbody tr");
  await pages(page, rows, "td:nth-child(2) .fw6", labels, "쿠폰 페이지 이동");
  await capture(page, "SA035");
  await page.getByRole("checkbox", { name: "쿠폰 모두 선택" }).check();
  await page.getByRole("navigation", { name: "쿠폰 페이지 이동" }).getByRole("button", { name: "마지막", exact: true }).click();
  await expect(rows.getByRole("checkbox").first()).toBeChecked();
  await page.getByRole("button", { name: "선택 발급 중지", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("23개가 더 이상 내려받아지지 않습니다");
  await page.getByRole("dialog").getByRole("button", { name: "발급 중지", exact: true }).click();
  await expect.poll(() => changed.length).toBe(23); expect(new Set(changed).size).toBe(23);
  await page.getByPlaceholder("쿠폰 이름 · 코드").fill("합성 쿠폰 2");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(rows).toHaveCount(3); await expect(rows.locator("td:nth-child(2) .fw6")).toHaveText(labels.slice(20));
  await expect(page.getByRole("navigation", { name: "쿠폰 페이지 이동" })).toHaveCount(0);
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(rows.locator("td:nth-child(2) .fw6")).toHaveText(labels.slice(0, 10));
});
test("SH034: 끝 쪽 감소·품절 전체 빼기·모두 비우기를 원 전체 배열에 적용한다", async ({ page, baseURL }) => {
  const labels = names("합성 찜");
  const original = labels.map((name, i) => ({ productId: `${run}-wish-${i}`, name, price: 1000, listPrice: 1000, status: i % 3 === 0 ? "sold_out" : "on_sale", wishedAt: new Date().toISOString(), isLive: false, eventBadge: null }));
  let items = [...original]; const deleted: string[] = [];
  await page.route("**/api/shop/demo-shop/wishlist", route => { expect(route.request().method()).toBe("GET"); return route.fulfill({ json: { items, count: items.length } }); });
  await page.route("**/api/shop/demo-shop/wishlist/*", route => { expect(route.request().method()).toBe("DELETE"); const id = new URL(route.request().url()).pathname.split("/").pop()!; expect(items.some(i => i.productId === id)).toBe(true); deleted.push(id); items = items.filter(i => i.productId !== id); return route.fulfill({ json: {} }); });
  const auth = await page.request.post("/api/shop/demo-shop/auth/login", { data: { loginId: "demo-buyer1@example.com", password: process.env.E2E_PASSWORD }, headers: { origin: baseURL! } }); expect(auth.status()).toBe(200);
  await page.goto("/shop/demo-shop/wishlist");
  const rows = page.locator(".wishlist-grid > li");
  await pages(page, rows, ".pc-name", labels, "찜 페이지 이동"); await capture(page, "SH034");
  const nav = page.getByRole("navigation", { name: "찜 페이지 이동" });
  await nav.getByRole("button", { name: "마지막", exact: true }).click();
  for (const count of [2, 1, 10]) { await rows.first().getByRole("button", { name: "찜 빼기", exact: true }).click(); await expect(rows).toHaveCount(count); }
  await expect(nav.getByRole("button", { name: "2페이지", exact: true })).toHaveAttribute("aria-current", "page");
  items = [...original]; deleted.length = 0; await page.reload();
  await page.getByRole("button", { name: "품절 상품 빼기", exact: true }).click();
  await expect(page.locator(".confirm-dialog")).toContainText("품절 상품 8개"); await okConfirm(page, "빼기");
  await expect.poll(() => deleted.length).toBe(8); expect(deleted).toEqual(original.filter(i => i.status === "sold_out").map(i => i.productId));
  await page.getByRole("button", { name: "모두 비우기", exact: true }).click(); await expect(page.getByRole("dialog")).toContainText("15개를 모두 뺄까요?");
  await page.getByRole("dialog").getByRole("button", { name: "모두 빼기", exact: true }).click();
  await expect(page.getByText("찜한 상품이 없어요", { exact: true })).toBeVisible(); expect(new Set(deleted).size).toBe(23);
  await expect(page.getByRole("navigation", { name: "찜 페이지 이동" })).toHaveCount(0);
});
