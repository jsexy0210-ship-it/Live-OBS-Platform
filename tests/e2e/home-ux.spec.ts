import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { Me } from "../../components/seller/api";
import type { Snapshot } from "../../components/seller/broadcast/queue";

// 실제 두 홈을 렌더링하되 모든 API는 브라우저에서 가로챈다. DB·외부 방송·변경 API는 실행하지 않는다.
test.use({ channel: process.platform === "win32" ? "chrome" : undefined });
const at = new Date().toISOString();
const keys = ["signupPending", "paymentFailed", "refundRequested", "inquiryOpen", "pgError", "automationFailed", "incidentCritical", "platformInfoMissing"];
const hrefs = ["/admin/partners/applications", "/admin/billing/invoices", "/admin/billing/refunds", "/admin/support/inquiries", "/admin/settlement/pg", "/admin/ops/automation", "/admin/ops/monitor", "/admin/settings/platform-business"];
const base = { revenue: 888_000, refundAmount: 88_000, netRevenue: 800_000, orders: 4, paidOrders: 3 };
const item = { id: "ui-order", status: "WAITING" as const, position: 1, receivedAt: at, nicknameSnapshot: "검증 구매자", gradeSnapshot: null, productLabel: "검증 상품", quantity: 1, timerSeconds: 0, openingStartedAt: null, doneAt: null, version: 1, broadcastSessionId: "ui-broadcast", amount: 48_000 };
const snapshot: Snapshot = { version: 1, broadcast: { id: "ui-broadcast", title: "검증 방송", startedAt: at }, opening: { ...item, id: "ui-opening", status: "OPENING", openingStartedAt: at }, waiting: [item], beforeBroadcast: [], recentDone: [] };
const owner: Me = { sellerId: "ui-seller", userId: "ui-owner", isOwner: true, permissions: [], access: "paid", features: ["STORE_OPERATIONS", "OVERLAY"], shop: { name: "검증 스토어", slug: "ui-store" }, user: { name: "검증 대표", email: "ui@example.com" }, trialEndsAt: null };

type Scenario = { zero?: boolean; taskError?: number; taskWait?: Promise<void>; role?: "SUPER_ADMIN" | "CS"; orderError?: number; seller?: Me; queue?: Snapshot; queueError?: number; version?: number; summaryError?: boolean };
async function mock(page: Page, scenario: Scenario = {}) {
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      writes.push(path);
      return route.fulfill({ status: 409, json: { error: "ui_test_write_blocked" } });
    }
    if (path === "/api/seller/stream") return route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\n\n" });
    if (path === "/api/admin/today-tasks") {
      await scenario.taskWait;
      if (scenario.taskError) return route.fulfill({ status: scenario.taskError, json: { error: "ui_read_error" } });
      return route.fulfill({ json: { at, total: scenario.zero ? 0 : 7, items: keys.map((key, i) => ({ key, href: hrefs[i], count: scenario.zero ? 0 : [3, 2, 1, 0, 0, 0, 0, 1][i], fields: key === "platformInfoMissing" ? ["name"] : undefined })) } });
    }
    if (path === "/api/admin/stats/orders" && scenario.orderError) return route.fulfill({ status: scenario.orderError, json: { error: "ui_read_error" } });
    if (path === "/api/seller/queue" && scenario.queueError) return route.fulfill({ status: scenario.queueError, json: { error: "ui_read_error" } });
    if (path === "/api/seller/broadcast/summary" && scenario.summaryError) return route.fulfill({ status: 500, json: { error: "ui_read_error" } });
    if (scenario.seller && !scenario.seller.isOwner && (path === "/api/seller/stats/overview" || path === "/api/seller/broadcast/history")) return route.fulfill({ status: 403, json: { error: "permission_required" } });
    const queue = scenario.queue ?? snapshot;
    const data: Record<string, unknown> = {
      "/api/maintenance": { active: false, scheduled: null },
      "/api/admin/me": { id: "ui-admin", name: "검증 관리자", email: "admin@example.com", role: scenario.role ?? "SUPER_ADMIN" },
      "/api/admin/dashboard": { at, sellers: { total: 4, PENDING: 3, ACTIVE: 1, SUSPENDED: 0, REJECTED: 0, CLOSED: 0 }, liveBroadcasts: 1, ordersToday: { created: 4, paid: 3, paidAmount: 888_000 }, subscriptions: { trial: 0, paid: 1, charging: 0, grace: 0, expired: 0 } },
      "/api/admin/stats/subscriptions": { current: { revenue: 777_000, refundAmount: 11_000 }, previous: { revenue: 555_000, refundAmount: 0 }, series: [] },
      "/api/admin/stats/orders": { current: base, previous: base, series: [] },
      "/api/admin/ops/monitor": { at, servers: { total: 2, healthy: 2 }, queue: { automationQueued: 0 }, jobs: [], incidents: [] },
      "/api/admin/infra/summary": { checkedAt: at, servers: [], cost: { month: at.slice(0, 7), estimated: true, accruedWon: null, projectedWon: null }, warnings: { capacity: 0, limitStopped: 0, expiring30: 0, expiring7: 0, authError: 0, total: 0 } },
      "/api/seller/me": scenario.seller ?? owner,
      "/api/seller/queue": queue,
      "/api/seller/queue/version": { version: scenario.version ?? queue.version },
      "/api/seller/broadcast/summary": { broadcast: queue.broadcast ? { ...queue.broadcast, status: "live", endedAt: null } : null, summary: { orders: 4, paidOrders: 3, sales: 888_000, completed: 1, cancelled: 0, hits: 0 } },
      "/api/seller/youtube": { configured: false, live: null, chatNotice: "" },
      "/api/seller/onboarding": { completed: true, dismissed: false, doneCount: 4, total: 4 },
      "/api/seller/today-tasks": { total: 2, items: [{ key: "depositPending", count: 2, href: "/seller/deposits" }] },
      "/api/seller/stats/overview": { summary: { current: { revenue: 888_000, orders: 4, averageOrderValue: 222_000 }, previous: { revenue: 444_000, orders: 2, averageOrderValue: 222_000 } }, operations: { cancelled: 0, refunded: 0, refundAmount: 0 } },
      "/api/seller/broadcast/history": { items: [] },
      "/api/seller/overlay/address-info": { lastAccessAt: null, lastClient: null, connected: false },
      "/api/seller/external-shops": { connections: [] },
    };
    return route.fulfill({ json: data[path] ?? { items: [], notices: [], unreadCount: 0, total: 0 } });
  });
  return writes;
}

async function geometryAndFont(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "main h1" });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((f) => f.isCustomFont && f.familyName.includes("Wanted Sans"))).toBe(true);
  await cdp.detach();
}

for (const width of [1440, 1024, 390]) {

  test(`파트너스 홈 ${width}: 방송 조작·개봉·대기가 성과보다 먼저`, async ({ page }) => {
    const writes = await mock(page);
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/seller");
    await expect(page.getByTestId("bc-opening")).toContainText("검증 상품");
    await expect(page.getByTestId("bc-waiting")).toContainText("48,000원");
    await expect(page.getByTestId("home-performance")).toBeVisible();
    expect(await page.locator("#broadcast").evaluate((el) => !!(el.compareDocumentPosition(document.querySelector(".home")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    expect(await page.getByTestId("bc-waiting").evaluate((el) => !!(el.compareDocumentPosition(document.querySelector('[data-testid="bc-summary"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(page.getByTestId("bc-youtube-notice")).toContainText("연결된 유튜브 방송이 없어요");
    await expect(page.getByRole("link", { name: "유튜브 연결", exact: true }).first()).toHaveAttribute("href", "/seller/youtube");
    await page.getByRole("button", { name: "방송 끝내기", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "방송을 끝낼까요?" });
    await expect(dialog).toContainText("남은 대기 1건은 다음 방송으로 넘어가요");
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(dialog).toBeHidden();
    await geometryAndFont(page);
    expect(writes).toEqual([]);
    if (process.env.CAPTURE_HOME_UX === "1") {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `tests/e2e/screenshots/SA-002-ux-${width}.png`, fullPage: true });
    }
  });
}

test("파트너스 홈: 오버레이 전용·운영 직원의 기존 기능 범위를 유지한다", async ({ page }) => {
  const scenario: Scenario = { seller: { ...owner, features: ["OVERLAY"] } };
  await mock(page, scenario);
  await page.goto("/seller");
  await expect(page.getByTestId("bc-opening")).toBeVisible();
  await expect(page.getByTestId("oh-tiles")).toBeVisible();
  await expect(page.getByTestId("home-performance")).toHaveCount(0);
  scenario.seller = { ...owner, isOwner: false, permissions: ["ORDER_READ", "ORDER_SHIP"], features: ["STORE_OPERATIONS"] };
  await page.reload();
  await expect(page.getByTestId("home-tasks")).toBeVisible();
  await expect(page.getByTestId("bc-opening")).toHaveCount(0);
  await expect(page.getByTestId("bc-hit-open")).toHaveCount(0);
  await expect(page.getByTestId("home-performance")).toHaveCount(0);
});

test("파트너스 홈: 빈 대기열과 조회 실패를 구분하고 요약 실패를 방송 없음으로 표시하지 않는다", async ({ page }) => {
  const scenario: Scenario = { queue: { ...snapshot, opening: null, waiting: [] }, summaryError: true };
  await mock(page, scenario);
  await page.goto("/seller");
  await expect(page.getByTestId("bc-opening-empty")).toContainText("대기 중인 주문이 없어요");
  await expect(page.getByTestId("bc-summary")).not.toContainText("오늘 방송 없음");
  await expect(page.getByTestId("bc-summary").locator(".v")).toHaveText(["-", "-", "-", "-"]);
  scenario.queueError = 500;
  await page.reload();
  await expect(page.getByText("주문대기를 불러오지 못했어요", { exact: true })).toBeVisible();
  await expect(page.getByTestId("bc-opening-empty")).toHaveCount(0);
  await expect(page.getByTestId("bc-waiting")).toHaveCount(0);
});

test("파트너스 홈: 최신 대기열 조회가 끊기면 이전 값을 보존하고 변경을 막는다", async ({ page }) => {
  await page.clock.install();
  const scenario: Scenario = {};
  const writes = await mock(page, scenario);
  await page.goto("/seller");
  await expect(page.getByTestId("bc-waiting")).toContainText("검증 상품");
  scenario.version = 2;
  scenario.queueError = 500;
  await page.clock.runFor(15_000);
  await expect(page.getByTestId("bc-stale")).toContainText("다시 불러오기 전까지 주문을 변경할 수 없어요");
  await expect(page.getByTestId("bc-waiting")).toContainText("48,000원");
  await expect(page.getByRole("button", { name: /개봉 완료/ })).toBeDisabled();
  expect(writes).toEqual([]);
});
