import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { Me } from "../../components/seller/api";

// 실제 PC 페이지를 렌더링하되 모든 API·외부 이동을 가로채 DB와 외부 쇼핑몰에 접근하지 않는다.
test.use({ channel: process.platform === "win32" ? "chrome" : undefined, viewport: { width: 1440, height: 960 } });
const base = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3100");
if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("loopback UI fixture only");
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
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) return route.abort();
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
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
  await expect(rows.nth(1)).toContainText("허용이 풀려 주문 알림이 멈췄어요");
  await expect(rows.nth(2)).toContainText("쇼핑몰 응답을 기다리는 중");
  await expect(page.getByTestId("external-status-guide").locator("tbody tr")).toHaveCount(3);
  const guide = page.locator("section.au-fs").filter({ has: page.getByRole("heading", { name: "변경 권한" }) });
  await expect(guide).toContainText("목록 조회도 같은 권한이 필요해요");
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
  if (process.env.CAPTURE_EXTERNAL_UI === "1" || process.env.E2E_SCREENSHOTS === "1") {
    mkdirSync("tests/e2e/screenshots", { recursive: true });
    await page.screenshot({ path: "tests/e2e/screenshots/SA-006-ux-1440.png", fullPage: true });
  }
  await expect(rows.locator("button")).toHaveCount(0);
  await expect(rows.nth(1).getByRole("link", { name: "연결 상세", exact: true })).toHaveAttribute("href", `/seller/external-shops/reauth?${new URLSearchParams({ returnTo: "/seller/external-shops" })}`);
  await rows.nth(1).getByRole("link", { name: "연결 상세", exact: true }).click();
  await expect(page).toHaveURL(`/seller/external-shops/reauth?${new URLSearchParams({ returnTo: "/seller/external-shops" })}`);
  await page.reload();
  const detail = page.getByTestId("external-detail");
  await expect(detail).toContainText("검증 재인증");
  await detail.getByRole("button", { name: "다시 연결", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("쇼핑몰 관리자 화면으로 이동해 앱 허용을 다시 받습니다");
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL("/seller/external-shops");
  await rows.nth(2).getByRole("link", { name: "연결 상세", exact: true }).click();
  await detail.getByRole("button", { name: "해제 다시 요청하기" }).click();
  await expect(page.getByRole("dialog")).toContainText("주문 알림이 더 들어오지 않습니다");
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL("/seller/external-shops");
  await page.clock.fastForward("02:00:00");
  await expect(rows.nth(0)).toContainText("2시간 전 · 주문 생성");
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("SA006 PC: 빈 상태·연결 준비·읽기 전용·403·조회 실패를 구분한다", async ({ page }) => {
  const scenario: Scenario = { connections: [], enabled: true, canManage: true };
  const writes = await mock(page, scenario);
  await page.goto("/seller/external-shops");
  await page.getByTestId("external-empty").getByRole("link", { name: "쇼핑몰 추가 연결" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/seller/external-shops/new?${new URLSearchParams({ returnTo: "/seller/external-shops" })}`);
  await expect(page.getByLabel("쇼핑몰 주소")).toBeVisible();
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  scenario.enabled = false;
  await page.reload();
  await expect(page.getByTestId("external-disabled")).toBeVisible();
  await expect(page.getByRole("link", { name: "쇼핑몰 추가 연결" })).toHaveCount(0);
  scenario.enabled = true; scenario.canManage = false;
  await page.reload();
  await expect(page.getByTestId("external-empty")).toBeVisible();
  await expect(page.getByRole("link", { name: "쇼핑몰 추가 연결" })).toHaveCount(0);
  scenario.connections = connections;
  await page.goto("/seller/external-shops/pending");
  await expect(page.getByTestId("external-detail")).toContainText("검증 해제 대기");
  await expect(page.getByTestId("external-detail").locator("button")).toHaveCount(0);
  await page.goto("/seller/external-shops");
  scenario.connections = [];
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
  const listHref = "/seller/external-shops?page=2";
  await expect(page).toHaveURL(listHref);
  const link = page.getByTestId("external-row").getByRole("link", { name: "연결 상세", exact: true });
  await expect(link).toHaveAttribute("href", `/seller/external-shops/connection-10?${new URLSearchParams({ returnTo: listHref })}`);
  await link.click();
  await page.reload();
  await expect(page.getByTestId("external-detail")).toContainText("검증 연결 11");
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(listHref);
  await expect(page.getByTestId("external-row")).toHaveCount(1);
});


test("SA006 상세: 새 연결·재연결·해제는 확인 후 해당 대상만 요청한다", async ({ page }) => {
  const scenario: Scenario = { connections: connections.map((row) => ({ ...row })), enabled: true, canManage: true };
  const unexpectedWrites = await mock(page, scenario);
  const sent: { method: string; path: string; body: unknown }[] = [];
  const authorizeUrl = new URL("/owned-external-authorization", base).href;
  await page.route("**/owned-external-authorization", (route) => route.fulfill({ contentType: "text/html", body: "<main>연결 인증 화면</main>" }));
  await page.route((url) => url.origin === base.origin && (url.pathname === "/api/seller/external-shops" || url.pathname === "/api/seller/external-shops/pending"), async (route) => {
    const method = route.request().method(), path = new URL(route.request().url()).pathname;
    if (method === "GET") return route.fallback();
    sent.push({ method, path, body: route.request().postData() ? route.request().postDataJSON() : null });
    if (method === "POST" && path === "/api/seller/external-shops") return route.fulfill({ json: { authorizeUrl } });
    if (method === "DELETE" && path === "/api/seller/external-shops/pending") {
      scenario.connections = scenario.connections.filter((row) => row.id !== "pending");
      return route.fulfill({ json: { status: "DISCONNECTED" } });
    }
    return route.fulfill({ status: 409, json: { error: "unexpected_write" } });
  });
  await page.goto("/seller/external-shops/new");
  await page.getByLabel("쇼핑몰 주소").fill(" https://owned.example.invalid ");
  await page.getByRole("button", { name: "이 주소로 연결 시작하기", exact: true }).click();
  let ask = page.getByRole("dialog", { name: "이 쇼핑몰을 연결하시겠습니까?", exact: true });
  await ask.getByRole("button", { name: "취소", exact: true }).click();
  expect(sent).toEqual([]);
  await page.getByRole("button", { name: "이 주소로 연결 시작하기", exact: true }).click();
  await ask.getByRole("button", { name: "연결 시작하기", exact: true }).click();
  await expect(page).toHaveURL(authorizeUrl);
  expect(sent).toEqual([{ method: "POST", path: "/api/seller/external-shops", body: { shopUrl: "https://owned.example.invalid" } }]);
  await page.goto("/seller/external-shops/reauth");
  await page.getByRole("button", { name: "다시 연결", exact: true }).click();
  ask = page.getByRole("dialog", { name: "검증 재인증 연결을 다시 하시겠습니까?", exact: true });
  await ask.getByRole("button", { name: "다시 연결하기", exact: true }).click();
  await expect(page).toHaveURL(authorizeUrl);
  expect(sent[1]).toEqual({ method: "POST", path: "/api/seller/external-shops", body: { connectionId: "reauth" } });
  await page.goto("/seller/external-shops/pending");
  await page.getByRole("button", { name: "해제 다시 요청하기", exact: true }).click();
  ask = page.getByRole("dialog", { name: "연결 해제를 다시 요청하시겠습니까?", exact: true });
  await ask.getByRole("button", { name: "취소", exact: true }).click();
  expect(sent).toHaveLength(2);
  await page.getByRole("button", { name: "해제 다시 요청하기", exact: true }).click();
  await ask.getByRole("button", { name: "해제 다시 요청하기", exact: true }).click();
  await expect(page.getByRole("region", { name: "연결 해제 결과", exact: true })).toBeVisible();
  expect(sent[2]).toEqual({ method: "DELETE", path: "/api/seller/external-shops/pending", body: null });
  await page.getByRole("button", { name: "목록으로", exact: true }).click();
  await expect(page).toHaveURL("/seller/external-shops");
  await expect(page.getByTestId("external-row")).toHaveCount(2);
  expect(unexpectedWrites).toEqual([]);
});
