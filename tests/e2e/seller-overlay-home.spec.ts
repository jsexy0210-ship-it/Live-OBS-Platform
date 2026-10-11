import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// SA-002-O 오버레이 전용 홈: 오버레이 전용 대표자는 /seller에서 이 홈으로 오고(업무 → 성과 → 방송, 스토어 기능 안내),
// 통합 요금제 대표자는 이 홈으로 보내지 않는다. dev-seed의 데모 쇼핑몰(통합 · demo-overlay)로 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller%2Fyoutube");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/youtube$/);
}

test("오버레이 전용 대표자: /seller가 오버레이 홈으로 열리고 업무·성과·방송·스토어 안내가 보인다", async ({ page }) => {
  await login(page, "demo-overlay-owner@example.com");
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByRole("heading", { name: "홈", level: 1 })).toBeVisible();
  // 머리 오른쪽 버튼 · 상태 3칸 · 지금 방송 · 스토어 안내(보드 SA-002-O)
  await expect(page.getByRole("link", { name: "방송 대시보드" })).toHaveCount(0);
  const waiting = page.getByRole("region", { name: "방송 전 대기 0건", exact: true });
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText("대기 중인 주문이 없습니다");
  await expect(page.getByTestId("bc-waiting")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "방송 화면 꾸미기" }).first()).toBeVisible();
  const tiles = page.getByTestId("oh-tiles");
  await expect(tiles.getByText("외부 쇼핑몰", { exact: true })).toBeVisible();
  await expect(tiles.getByText("오늘 들어온 주문", { exact: true })).toBeVisible();
  await expect(tiles.getByText("방송 화면", { exact: true })).toBeVisible();
  await expect(page.getByTestId("oh-live")).toContainText("지금 방송");
  // 스토어 업무(입금·배송·재고)는 없고 통합 구독 안내가 있다
  await expect(page.getByText("입금 확인")).toHaveCount(0);
  const up = page.getByTestId("oh-upgrade");
  await expect(up).toContainText("스토어 메뉴는 쇼핑몰 통합에서 열립니다");
  await expect(up).toContainText("통합 구독");
  const notice = page.getByTestId("seller-home-mobile-notice");
  await expect(notice).toBeHidden();
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("home-tasks")).toHaveCount(0);
  expect((await page.request.get("/api/seller/products")).status()).toBe(403);
  await expect.poll(() => page.locator(".lnb").evaluate((el) => el.getBoundingClientRect().right <= 0 && !el.getAnimations().some((a) => a instanceof CSSTransition && a.playState === "running"))).toBe(true);
  const sidebar = await page.locator(".lnb").evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: parseFloat(getComputedStyle(el).width), transitions: el.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === "running").length }; });
  const metrics = await tiles.evaluate((el) => ({ viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null }, height: document.documentElement.scrollHeight, values: Array.from(el.querySelectorAll(".stat .v")).map((v) => ({ text: v.textContent?.trim(), label: v.closest(".stat")?.querySelector(".t-l2")?.textContent?.trim(), client: v.clientWidth, scroll: v.scrollWidth })) }));
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const evidence = `tests/e2e/screenshots/current-shell-${sourceSha}`;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: "tests/e2e/screenshots/seller-home-mobile-overlay-owner-390.png", fullPage: true });
  writeFileSync(`${evidence}/seller-home-mobile-overlay-owner-390.json`, JSON.stringify({ sourceSha, route: new URL(page.url()).pathname, role: "OVERLAY_OWNER", state: "content", sidebar, ...metrics }, null, 2));
  expect(metrics.values).toHaveLength(3);
  for (const value of metrics.values) expect(value.scroll).toBeLessThanOrEqual(value.client);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await expect(page.locator(".cs")).toHaveClass(/nav-open/);
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).locator('a[href="/seller/overlay/address"]').click();
  await expect(page).toHaveURL(/\/seller\/overlay\/address$/);
  await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
  await expect(notice).toHaveCount(0);
  await page.goto("/seller");
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  await up.getByRole("link", { name: "쇼핑몰 통합으로 바꾸기" }).click();
  await expect(page).toHaveURL(/\/seller\/subscription/);
  if (SHOTS) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/seller/home-overlay");
    await expect(page).toHaveURL(/\/seller$/);
    await expect(page.getByRole("heading", { name: "홈", level: 1 })).toBeVisible();
    await expect(tiles).toBeVisible();
    await expect.poll(() => page.locator("main.main img").evaluateAll((images) => images.every((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0))).toBe(true);
    const desktopMetrics = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null }, height: document.documentElement.scrollHeight }));
    await page.screenshot({ path: "tests/e2e/screenshots/SA-002-O-1440.png", fullPage: true });
    writeFileSync(`${evidence}/SA-002-O-1440.json`, JSON.stringify({ sourceSha, route: new URL(page.url()).pathname, role: "OVERLAY_OWNER", state: "content", ...desktopMetrics }, null, 2));
  }
});

test("메뉴 「홈」으로도 열린다", async ({ page }) => {
  await login(page, "demo-overlay-owner@example.com");
  await page.goto("/seller");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByText("홈", { exact: true }).click();
  await expect(page).toHaveURL(/\/seller$/);
});

test("통합 요금제 대표자는 오버레이 홈으로 가지 않는다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await page.goto("/seller");
  await expect(page.getByTestId("home-tasks")).toBeVisible();
  await expect(page).toHaveURL(/\/seller$/);
});
