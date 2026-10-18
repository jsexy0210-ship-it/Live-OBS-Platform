import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { Me } from "../../components/seller/api";

// 실제 PC 페이지를 렌더링하되 모든 API·외부 이동을 가로채 DB와 외부 쇼핑몰에 접근하지 않는다.
test.use({ channel: process.platform === "win32" ? "chrome" : undefined, viewport: { width: 1440, height: 960 } });
const me: Me = { sellerId: "ui-seller", userId: "ui-owner", isOwner: true, permissions: [], access: "paid", features: ["OVERLAY", "EXTERNAL_INTEGRATION"], shop: { name: "검증 스토어", slug: "ui-store" }, user: { name: "검증 대표", email: "ui@example.com" }, trialEndsAt: null };
const now = new Date("2026-10-18T03:00:00Z");
const connections = [
  { id: "connected", shopKey: "검증 연결", status: "CONNECTED", connectedAt: "2026-10-01T00:00:00Z", lastEventAt: new Date(now.getTime() - 120_000).toISOString(), lastEventKind: "ORDER_CREATED" },
  { id: "reauth", shopKey: "검증 재인증", status: "REAUTH_REQUIRED", connectedAt: "2026-10-01T00:00:00Z", lastEventAt: null, lastEventKind: null },
  { id: "pending", shopKey: "검증 해제 대기", status: "DISCONNECT_PENDING", connectedAt: "2026-10-01T00:00:00Z", lastEventAt: null, lastEventKind: null },
];
type Scenario = { connections: typeof connections; enabled: boolean; canManage: boolean; status?: number };
async function mock(page: Page, scenario: Scenario) {
  const writes: string[] = [];
  await page.route("https://**/*", (route) => route.abort());
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      writes.push(path);
      return route.fulfill({ status: 409, json: { error: "ui_test_write_blocked" } });
    }
    if (path === "/api/seller/me") return route.fulfill({ json: me });
    if (path === "/api/maintenance") return route.fulfill({ json: { active: false, scheduled: null } });
    if (path === "/api/seller/external-shops") return route.fulfill(scenario.status ? { status: scenario.status, json: { error: "ui_read_error" } } : { json: scenario });
    return route.fulfill({ json: { items: [], notices: [], unreadCount: 0, total: 0 } });
  });
  return writes;
}

test("SA006 PC: 상태·주문 알림·안내와 기존 확인 동작을 보존한다", async ({ page }) => {
  const writes = await mock(page, { connections, enabled: true, canManage: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: now });
  await page.goto("/seller/external-shops");
  const rows = page.getByTestId("external-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("2분 전 · 주문 생성");
  await expect(rows.nth(0)).toContainText("2026.10.01");
  await expect(rows.nth(1)).toContainText("허용이 풀려 주문 알림이 멈췄습니다");
  await expect(rows.nth(2)).toContainText("쇼핑몰 응답을 기다리는 중");
  await expect(page.getByTestId("external-status-guide").locator("tbody tr")).toHaveCount(3);
  const guide = page.locator("section.au-fs").filter({ has: page.getByRole("heading", { name: "변경 권한" }) });
  await expect(guide).toContainText("목록 조회도 같은 권한이 필요합니다");
  const left = await page.getByTestId("external-status-guide").boundingBox(), right = await guide.boundingBox();
  expect(left && right).toBeTruthy();
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(1);
  expect(right!.x).toBeGreaterThan(left!.x);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "main h1" });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((font) => font.isCustomFont && font.familyName.includes("Wanted Sans"))).toBe(true);
  await cdp.detach();
  if (process.env.CAPTURE_EXTERNAL_UI === "1") {
    mkdirSync("tests/e2e/screenshots", { recursive: true });
    await page.screenshot({ path: "tests/e2e/screenshots/SA-006-ux-1440.png", fullPage: true });
  }
  await rows.nth(1).getByRole("button", { name: "다시 연결", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("쇼핑몰 관리자 화면으로 이동해 앱 허용을 다시 받습니다");
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  await rows.nth(2).getByRole("button", { name: "해제 다시 요청하기" }).click();
  await expect(page.getByRole("dialog")).toContainText("주문 알림이 더 들어오지 않습니다");
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  await page.clock.fastForward("02:00:00");
  await expect(rows.nth(0)).toContainText("2시간 전 · 주문 생성");
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("SA006 PC: 빈 상태·연결 준비·읽기 전용·403·조회 실패를 구분한다", async ({ page }) => {
  const scenario: Scenario = { connections: [], enabled: true, canManage: true };
  const writes = await mock(page, scenario);
  await page.goto("/seller/external-shops");
  await page.getByTestId("external-empty").getByRole("button", { name: "쇼핑몰 추가 연결" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("쇼핑몰 주소")).toBeVisible();
  scenario.enabled = false;
  await page.reload();
  await expect(page.getByTestId("external-disabled")).toBeVisible();
  await expect(page.getByRole("button", { name: "쇼핑몰 추가 연결" })).toHaveCount(0);
  scenario.enabled = true; scenario.canManage = false;
  await page.reload();
  await expect(page.getByTestId("external-empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "쇼핑몰 추가 연결" })).toHaveCount(0);
  scenario.status = 403;
  await page.reload();
  await expect(page.getByTestId("external-forbidden")).toBeVisible();
  await expect(page.getByTestId("external-empty")).toHaveCount(0);
  scenario.status = 500;
  await page.reload();
  await expect(page.getByText("연동 정보를 불러오지 못했습니다")).toBeVisible();
  await expect(page.getByTestId("external-empty")).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("SA006 PC: 원배열 11개와 현재 쪽 10개·마지막 쪽 이동을 유지한다", async ({ page }) => {
  const items = Array.from({ length: 11 }, (_, index) => ({ ...connections[0], id: `connection-${index}`, shopKey: `검증 연결 ${index + 1}` }));
  await mock(page, { connections: items, enabled: true, canManage: true });
  await page.goto("/seller/external-shops");
  await expect(page.getByTestId("external-row")).toHaveCount(10);
  await expect(page.getByText("전체 연결 11곳")).toBeVisible();
  await page.getByRole("button", { name: "마지막", exact: true }).click();
  await expect(page.getByTestId("external-row")).toHaveCount(1);
  await expect(page.getByTestId("external-row")).toContainText("검증 연결 11");
});
