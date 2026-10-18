import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { Me } from "../../components/seller/api";

// 격리된 실제 Next 페이지의 PC 레이아웃 회귀. 모든 API는 가로채며 외부·실환경 접근은 거부한다.
const base = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3100");
if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("이 시험은 loopback 주소에서만 실행합니다.");
test.use({ channel: process.platform === "win32" ? "chrome" : undefined });
const me: Me = { sellerId: "ui-seller", userId: "ui-owner", isOwner: true, permissions: [], access: "paid", features: ["OVERLAY"], shop: { name: "검증 스토어", slug: "ui-store" }, user: { name: "검증 대표", email: "ui@example.com" }, trialEndsAt: null };
const row = (index: number) => ({ id: `ui-${index}`, title: `검증 방송 ${index}`, status: "ended", startedAt: new Date(Date.now() - index * 86_400_000).toISOString(), endedAt: new Date(Date.now() - index * 86_400_000 + 3_600_000).toISOString(), layout: "9x16", summary: { orders: 5, paidOrders: 5, sales: 240_000, completed: 4, cancelled: 1, hits: 2 } });

async function mock(page: Page, count: number, state?: { wait: Promise<void>; status: number; error?: string }) {
  const reads: URL[] = [], writes: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (route.request().method() !== "GET") {
      writes.push(url.pathname);
      return route.fulfill({ status: 409, json: { error: "ui_test_write_blocked" } });
    }
    if (url.pathname === "/api/seller/me") return route.fulfill({ json: me });
    if (url.pathname === "/api/maintenance") return route.fulfill({ json: { active: false, scheduled: null } });
    if (url.pathname === "/api/seller/broadcast/history") {
      reads.push(url);
      if (state) {
        await state.wait;
        if (state.status !== 200) return route.fulfill({ status: state.status, json: { error: state.error } });
      }
      return route.fulfill({ json: { items: Array.from({ length: url.searchParams.has("cursor") ? 1 : count }, (_, index) => row(index)), nextCursor: count === 0 || url.searchParams.has("cursor") ? null : "ui-next" } });
    }
    return route.fulfill({ json: { items: [], notices: [], unreadCount: 0, total: 0 } });
  });
  return { reads, writes };
}

for (const state of [
  { name: "조회 오류", status: 500, error: "internal", text: "방송 기록을 불러오지 못했습니다" },
  { name: "이용 잠금", status: 402, error: "access_expired", text: "이용 기간이 끝나 지금은 사용할 수 없습니다" },
  { name: "권한 없음", status: 403, error: "forbidden", text: "이 계정은 이 일을 할 수 없습니다" },
  { name: "빈 목록", status: 200, text: "최근 1개월에는 방송 기록이 없습니다" },
]) {
  test(`SA054 PC 1440: 로딩과 ${state.name}의 기존 상태 프레임을 보존한다`, async ({ page }) => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const { writes } = await mock(page, 0, { ...state, wait });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/seller/broadcasts");
    const section = page.locator(".au-list-section");
    const loading = section.getByLabel("불러오는 중");
    await expect(loading).toBeVisible();
    const loadingFrame = section.locator(":scope > .card");
    await expect(loadingFrame).toHaveCount(1);
    await expect(loadingFrame).not.toHaveCSS("box-shadow", "none");
    await expect(loading).toHaveCSS("box-shadow", "none");
    release();
    await expect(loading).toHaveCount(0);
    await expect(section).toContainText(state.text);
    const frame = section.locator(".card");
    await expect(frame).toHaveCount(1);
    await expect(frame).not.toHaveCSS("box-shadow", "none");
    await expect(frame).toHaveCSS("border-radius", "12px");
    await expect(frame.locator(".au-lh, .onq-pagination, .card")).toHaveCount(0);
    await expect(section.getByRole("region", { name: "방송 기록 표" })).toHaveCount(0);
    if (state.status === 200) {
      await expect(section.locator(".au-lh")).toContainText("불러온 0건");
      await expect(frame.getByTestId("bh-empty")).toBeVisible();
      await expect(frame.getByRole("link", { name: "방송 대시보드" })).toHaveAttribute("href", "/seller/broadcast");
    } else if (state.status === 500) {
      await expect(frame.getByRole("button", { name: "다시 시도" })).toBeEnabled();
    } else if (state.status === 403) {
      await expect(frame).toHaveAttribute("data-testid", "permission-card");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect(writes).toEqual([]);
  });
}

for (const [count, height] of [[5, 960], [10, 650]]) {
  test(`SA054 PC 1440×${height} ${count}행: 필터·표 경계와 기존 조작을 보존한다`, async ({ page }) => {
    const { reads, writes } = await mock(page, count);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height });
    await page.goto("/seller/broadcasts");
    await expect(page.getByTestId("bh-list").locator("tr")).toHaveCount(count);
    const form = page.getByRole("search"), grid = page.getByRole("region", { name: "방송 기록 표" });
    const section = page.locator(".au-list-section"), head = section.locator(".au-lh"), pager = section.getByRole("navigation", { name: "페이지 이동" });
    await expect(head).toContainText(`불러온 ${count}건`);
    await expect(grid.locator(".au-lh, .onq-pagination")).toHaveCount(0);
    await expect(grid.locator("table thead th")).toHaveCount(9);
    await expect(section).toHaveCSS("box-shadow", "none");
    await expect(grid).toHaveCSS("border-top-width", "1px");
    await expect(grid).toHaveCSS("overflow-x", "auto");
    const f = await form.boundingBox(), footer = await form.locator(".au-sb-f").boundingBox();
    const search = await form.getByRole("button", { name: "검색", exact: true }).boundingBox();
    const reset = await form.getByRole("button", { name: "초기화", exact: true }).boundingBox();
    const h = await head.boundingBox(), g = await grid.boundingBox(), p = await pager.boundingBox();
    expect(f && footer && search && reset && h && g && p).toBeTruthy();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(f!.y + f!.height + 1);
    for (const button of [search!, reset!]) expect(button.y + button.height).toBeLessThan(f!.y + f!.height);
    expect(h!.y + h!.height).toBeLessThanOrEqual(g!.y);
    expect(g!.y + g!.height).toBeLessThanOrEqual(p!.y);
    expect(Math.abs(h!.x - g!.x)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    console.log(JSON.stringify({ rows: count, height, formBottom: f!.y + f!.height, buttonBottom: search!.y + search!.height, headBottom: h!.y + h!.height, gridTop: g!.y, gridBottom: g!.y + g!.height, pagerTop: p!.y }));
    await expect(page.getByTestId("bh-link").first()).toHaveAttribute("href", "/seller/broadcasts/ui-0");
    if ((process.env.CAPTURE_BROADCAST_LAYOUT === "1" || process.env.E2E_SCREENSHOTS === "1") && count === 5) {
      mkdirSync("tests/e2e/screenshots", { recursive: true });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: "tests/e2e/screenshots/sa054-after-1440.png", fullPage: true });
    }

    const start = form.getByRole("textbox", { name: "시작일", exact: true });
    await start.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const dropdown = await page.getByRole("dialog").boundingBox();
    expect(dropdown!.x).toBeGreaterThanOrEqual(0);
    expect(dropdown!.x + dropdown!.width).toBeLessThanOrEqual(1440);
    expect(dropdown!.y + dropdown!.height).toBeLessThanOrEqual(height);
    await page.keyboard.press("Escape");
    await expect(start).toBeFocused();
    await form.getByLabel("레이아웃").selectOption("16x9");
    await form.getByRole("button", { name: "검색", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => reads.at(-1)?.searchParams.get("layout")).toBe("16x9");
    await form.getByRole("button", { name: "초기화", exact: true }).click();
    await expect.poll(() => reads.at(-1)?.searchParams.has("layout")).toBe(false);
    await expect(page.getByTestId("bh-list").locator("tr")).toHaveCount(count);
    await pager.getByRole("button", { name: "다음", exact: true }).click();
    await expect(page.getByTestId("bh-list").locator("tr")).toHaveCount(1);
    await expect(head).toContainText("불러온 1건");
    await expect.poll(() => reads.at(-1)?.searchParams.get("cursor")).toBe("ui-next");

    // 표 내부가 좁아져도 문서 전체를 숨기지 않고 가로 스크롤·키보드 포커스를 유지한다.
    await grid.evaluate((element) => { element.style.maxWidth = "700px"; });
    // 표 내용이 가용 폭에 맞춰 줄어드는 경우와 구분해, 시험용 표를 명시적으로 넓힌다.
    await grid.locator("table").evaluate((element) => { element.style.minWidth = "1000px"; });
    await grid.focus();
    await expect(grid).toBeFocused();
    expect(await grid.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => grid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
