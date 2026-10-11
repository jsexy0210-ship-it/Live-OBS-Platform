import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// SA-002 파트너스 홈: 오늘 처리할 일 → 오늘 성과 → 방송. 화면 숫자는 같은 API 값과 같아야 한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller");
  await submitSellerLogin(page, email, PASSWORD);
  await page.waitForURL((u) => !u.pathname.startsWith("/seller/login"));
  await page.goto("/seller");
}

type Tasks = { total: number; items: { key: string; count: number; href: string }[] };

async function captureMobileHome(page: Page, name: string, role: "STORE_OWNER" | "STAFF") {
  const metrics = await page.locator("main.main").evaluate((main) => ({
    viewport: { width: innerWidth, height: innerHeight }, height: document.documentElement.scrollHeight, drawerOpen: !!document.querySelector(".cs.nav-open"),
    amounts: Array.from(main.querySelectorAll(".stat .v")).map((el) => { const range = document.createRange(); range.selectNodeContents(el); return { text: el.textContent?.trim(), label: el.closest(".stat")?.querySelector(".t-l2")?.textContent?.trim(), lines: range.getClientRects().length, client: el.clientWidth, scroll: el.scrollWidth }; }),
  }));
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const evidence = `tests/e2e/screenshots/current-shell-${sourceSha}`;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: `tests/e2e/screenshots/${name}.png`, fullPage: true });
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify({ sourceSha, route: new URL(page.url()).pathname, role, ...metrics }, null, 2));
  return metrics;
}

test("대표자: 오늘 처리할 일 → 오늘 성과 → 방송 순서로 보이고, 처리할 일 숫자는 API와 같다", async ({ page }) => {
  await open(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByRole("heading", { name: "홈", exact: true })).toBeVisible();

  const headings = page.locator(".home-sec-h h2");
  await expect(headings).toHaveText([/오늘 처리할 일/, /오늘 성과/, /방송/]);

  const api = (await page.request.get("/api/seller/today-tasks").then((r) => r.json())) as Tasks;
  expect(api.items.map((i) => i.key)).toEqual(["depositPending", "shipPending", "returnRequested", "inquiryWaiting", "stockOut", "stockLow"]);
  for (const t of api.items) {
    const tile = page.getByTestId(`home-task-${t.key}`);
    await expect(tile).toBeVisible();
    await expect(tile.locator(".v")).toHaveText(t.count.toLocaleString("ko-KR"));
    await expect(tile).toHaveAttribute("href", t.href);
  }
  await expect(page.getByTestId("home-performance")).toBeVisible();
  await expect(page.getByTestId("home-performance").locator(".stat")).toHaveCount(4);
  await expect(page.getByTestId("seller-home-mobile-notice")).toBeHidden();
});

test("처리할 일을 누르면 그 처리 화면으로 간다", async ({ page }) => {
  await open(page, "demo-owner@example.com");
  await page.getByTestId("home-task-depositPending").click();
  await expect(page).toHaveURL(/\/seller\/orders\/deposits$/);
});

test("주문·배송 권한만 있는 직원: 읽을 수 있는 처리할 일만 보이고 성과·방송 구역은 감춘다", async ({ page }) => {
  await open(page, "demo-viewer@example.com");
  await expect(page.getByRole("heading", { name: "홈", exact: true })).toBeVisible();
  await expect(page.getByTestId("home-task-depositPending")).toBeVisible();
  await expect(page.getByTestId("home-task-shipPending")).toBeVisible();
  await expect(page.getByTestId("home-task-inquiryWaiting")).toHaveCount(0);
  await expect(page.getByTestId("home-task-stockOut")).toHaveCount(0);
  await expect(page.getByTestId("home-performance")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("seller-home-mobile-notice")).toBeVisible();
  await expect(page.getByTestId("bc-opening")).toHaveCount(0);
  await expect(page.getByTestId("bc-waiting")).toHaveCount(0);
  await captureMobileHome(page, "seller-home-mobile-staff-390", "STAFF");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});

test("390 폭에서도 가로 스크롤 없이 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "demo-owner@example.com");
  await expect(page.getByTestId("home-tasks")).toBeVisible();
  const notice = page.getByTestId("seller-home-mobile-notice");
  await expect(notice).toHaveText("모바일에서는 홈 화면을 제공합니다 상세 관리 업무는 PC에서 이용해 주세요");
  await expect(notice).toBeVisible();
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const overview = await page.request.get(`/api/seller/stats/overview?from=${today}&to=${today}`);
  expect(overview.status()).toBe(200);
  const performance = (await overview.json()).summary.current;
  for (const [label, value] of [["결제된 매출", performance.revenue], ["주문 1건당 평균 금액", performance.averageOrderValue]] as const) {
    await expect(page.getByTestId("home-performance").locator(".stat").filter({ has: page.getByText(label, { exact: true }) }).locator(".v")).toHaveText(value === null ? "—" : `${value.toLocaleString("ko-KR")}원`);
  }
  const metrics = await captureMobileHome(page, "seller-home-mobile-store-owner-390", "STORE_OWNER");
  for (const amount of metrics.amounts.filter((a) => a.label === "결제된 매출" || a.label === "주문 1건당 평균 금액")) { expect(amount.lines).toBe(1); expect(amount.scroll).toBeLessThanOrEqual(amount.client); }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await expect(page.locator(".cs")).toHaveClass(/nav-open/);
  await captureMobileHome(page, "seller-home-mobile-store-drawer-390", "STORE_OWNER");
  await page.goBack();
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "입금 확인", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/orders\/deposits(?:\?|$)/);
  await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
  await expect(notice).toHaveCount(0);
});

type Onboarding = { completed: boolean; dismissed: boolean; doneCount: number; total: number };

test("시작하기 띠: 온보딩이 끝나지 않았을 때만 진행 N/M을 보이고, 닫으면 서버에 저장돼 사라지고, 다시 열면 돌아온다", async ({ page }) => {
  await open(page, "demo-owner@example.com");
  const post = (action: string) =>
    page.evaluate(async (a) => (await fetch("/api/seller/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: a }) })).status, action);
  expect(await post("reopen")).toBe(200);
  await page.reload();
  const state = (await page.request.get("/api/seller/onboarding").then((r) => r.json())) as Onboarding;
  const strip = page.getByTestId("home-onboarding");
  if (state.completed) {
    // 모두 끝낸 계정은 띠가 없다
    await expect(page.getByTestId("home-tasks")).toBeVisible();
    await expect(strip).toHaveCount(0);
    return;
  }
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(`${state.doneCount}/${state.total} 완료`);
  await expect(strip.getByRole("link", { name: "이어서 하기" })).toHaveAttribute("href", "/seller/onboarding");
  await strip.getByRole("button", { name: "시작하기 안내 숨기기" }).click();
  await page.getByRole("dialog", { name: "시작하기 안내를 숨기시겠습니까?" }).getByRole("button", { name: "숨기기" }).click();
  await expect(strip).toHaveCount(0);
  expect(((await page.request.get("/api/seller/onboarding").then((r) => r.json())) as Onboarding).dismissed).toBe(true);
  await page.reload();
  await expect(page.getByTestId("home-tasks")).toBeVisible();
  await expect(strip).toHaveCount(0);
  expect(await post("reopen")).toBe(200);
  await page.reload();
  await expect(strip).toBeVisible();
});
