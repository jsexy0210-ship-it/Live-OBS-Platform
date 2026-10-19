import { expect, test, type Page } from "@playwright/test";
import type { Me } from "../../components/seller/api";

// 기존 PR CI의 격리 Next 페이지에서 GET 실패와 빈 자료를 구분한다. 변경 API·외부 요청은 실행하지 않는다.
const base = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3100");
if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("loopback 주소에서만 실행합니다.");
test.use({ channel: process.platform === "win32" ? "chrome" : undefined });
const at = "2026-10-18T00:00:00.000Z";
const owner: Me = { sellerId: "ui-seller", userId: "ui-owner", isOwner: true, permissions: [], access: "paid", features: ["STORE_OPERATIONS", "OVERLAY"], shop: { name: "검증 스토어", slug: "ui-store" }, user: { name: "검증 대표", email: "ui@example.com" }, trialEndsAt: null };
type Reply = { status?: number; json: unknown };
async function mock(page: Page, respond: (url: URL) => Reply | Promise<Reply | undefined> | undefined) {
  const writes: string[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (route.request().method() !== "GET") {
      writes.push(url.pathname);
      return route.fulfill({ status: 409, json: { error: "ui_test_write_blocked" } });
    }
    const reply = await respond(url);
    if (reply) return route.fulfill(reply);
    const defaults: Record<string, unknown> = {
      "/api/seller/me": owner,
      "/api/admin/me": { id: "ui-admin", role: "SUPER_ADMIN", name: "검증 관리자", email: "admin@example.com" },
      "/api/maintenance": { active: false, scheduled: null },
      "/api/admin/alerts": { items: [], unreadCount: 0, counts: { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0 }, nextCursor: null },
      "/api/seller/shop-content/logo": { logo: null },
    };
    if (url.pathname in defaults) return route.fulfill({ json: defaults[url.pathname] });
    return route.fulfill({ status: 500, json: { error: "ui_unconfigured_read" } });
  });
  return { writes, errors };
}
const failed = { status: 500, json: { error: "ui_read_error" } };

test("SA052: 조회 실패는 미발급·OBS 미접속으로 표시하지 않고 GET 재시도로 구분한다", async ({ page }) => {
  let attempts = 0;
  const result = await mock(page, (url) => url.pathname === "/api/seller/overlay/address-info" ? ++attempts === 1 ? failed : { json: { issuedAt: null, lastAccessAt: null, lastClient: null, connected: false, openSources: 0, live: false, accesses: [], reissues: [] } } : undefined);
  await page.goto("/seller/overlay/address");
  await expect(page.getByText("주소 정보를 불러오지 못했어요", { exact: true })).toBeVisible();
  await expect(page.getByTestId("ovu-ac-empty")).toHaveCount(0);
  await expect(page.getByText("아직 발급 기록이 없습니다", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByTestId("ovu-ac-empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "주소 만들기", exact: true })).toBeEnabled();
  expect(attempts).toBe(2);
  expect(result.writes).toEqual([]); expect(result.errors).toEqual([]);
});

test("SA060: 로고 성공과 설정 조회 실패를 구분하고 재시도로 실제 운영 상태를 표시한다", async ({ page }) => {
  let attempts = 0;
  const result = await mock(page, (url) => {
    if (url.pathname === "/api/seller/shop-profile") return ++attempts === 1 ? failed : { json: { profile: { shopName: "검증 이름", shopTagline: "", operatingState: "PAUSED", topNotice: null, homeBenefitBannerVisible: true, usageGuide: null, primaryAddress: "DEFAULT", primaryDomain: null } } };
  });
  await page.goto("/seller/settings/shop");
  const error = page.getByRole("alert").filter({ hasText: "쇼핑몰 설정을 불러오지 못했어요" });
  await expect(error).toBeVisible();
  await expect(page.getByTestId("logo-box")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "운영 상태" })).toHaveCount(0);
  await error.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByLabel("쇼핑몰 이름", { exact: true })).toHaveValue("검증 이름");
  await expect(page.getByRole("radio", { name: "일시 정지", exact: true })).toBeChecked();
  expect(attempts).toBe(2);
  expect(result.writes).toEqual([]); expect(result.errors).toEqual([]);
});

test("MA088: 상세 로그 404를 빈 변경 이력으로 만들지 않고 전체 이력을 다시 읽는다", async ({ page }) => {
  let attempts = 0;
  const result = await mock(page, (url) => {
    if (url.pathname === "/api/admin/settings/platform-business") return { json: { name: "검증 플랫폼", representative: "검증 대표", businessNumber: "000-00-00000", mailOrderNumber: "", address: "", phone: "", email: "", complete: false, updatedAt: null } };
    if (url.pathname === "/api/admin/audit-logs") return { json: { logs: [{ id: "ui-log", createdAt: at }] } };
    if (url.pathname === "/api/admin/audit-logs/ui-log") return ++attempts === 1 ? { status: 404, json: { error: "not_found" } } : { json: { log: { after: { fields: ["name"] }, actorAdmin: { name: "검증 담당자" } } } };
  });
  await page.goto("/admin/settings/platform-business");
  const history = page.getByTestId("pb-history");
  await expect(history).toContainText("변경 이력을 불러오지 못했어요");
  await expect(history).not.toContainText("아직 변경 기록이 없습니다");
  await history.getByRole("button", { name: "다시 시도" }).click();
  await expect(history).toContainText("검증 담당자");
  await expect(history).toContainText("상호");
  expect(attempts).toBe(2);
  expect(result.writes).toEqual([]); expect(result.errors).toEqual([]);
});

test("MA083: 이력 GET 실패를 빈 기록으로 표시하지 않고 기존 설정과 GET 재시도를 유지한다", async ({ page }) => {
  let attempts = 0;
  const result = await mock(page, (url) => {
    if (url.pathname === "/api/admin/settings/maintenance") return { json: { maintenance: { active: false, scheduled: false, enabled: false, message: "", reason: "", history: [], liveBroadcasts: 0, waitingOrders: 0, startsAt: null, endsAt: null, version: 1, updatedAt: null, updatedByAdminName: null } } };
    if (url.pathname === "/api/admin/settings/maintenance/windows") return ++attempts === 1 ? failed : { json: { history: [{ id: "ui-window", phase: "ENDED", kind: "IMMEDIATE", startsAt: at, endedAt: at, reason: "검증 점검", message: "", createdByName: null, affectedBroadcasts: 0 }] } };
  });
  await page.goto("/admin/settings/maintenance");
  const history = page.getByTestId("maintenance-history");
  await expect(history).toContainText("점검 이력을 불러오지 못했어요");
  await expect(history).not.toContainText("변경 기록이 없습니다");
  await expect(page.getByTestId("maintenance-form")).toBeVisible();
  await history.getByRole("button", { name: "다시 시도" }).click();
  await expect(history).toContainText("검증 점검");
  expect(attempts).toBe(2);
  expect(result.writes).toEqual([]); expect(result.errors).toEqual([]);
});

test("MA013: 메모 GET 404 재시도와 검토 행 전환에서 다른 행의 메모를 노출하지 않는다", async ({ page }) => {
  let attempts = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const applications = ["a", "b"].map((id) => ({ id, slug: id, shopName: `검증 ${id}`, state: "REVIEW", applicantName: "검증 신청자", applicantEmail: "ui@example.com", businessNumber: null, industry: null, receivedAt: at, elapsedHours: 0, over48h: false, reasons: [{ code: "ui", text: "검증 필요" }], checks: [], checkedAt: null, supplement: null, license: null, businessAddress: null, channelUrl: null }));
  const result = await mock(page, async (url) => {
    if (url.pathname === "/api/admin/sellers/review") return { json: { sellers: applications.map((app) => ({ id: app.id, reviewReasons: ["ui"] })) } };
    const detail = applications.find((app) => url.pathname === `/api/admin/sellers/${app.id}`);
    if (detail) return { json: { seller: { id: detail.id, slug: detail.slug, shopName: detail.shopName, status: "PENDING", businessInfo: null, owner: null, plan: null, createdAt: at } } };
    const application = applications.find((app) => url.pathname === `/api/admin/sellers/${app.id}/application`);
    if (application) return { json: { application, undoableUntil: null } };
    if (url.pathname === "/api/admin/sellers/applications") return { json: {
      chips: { all: 2, clear: 0, review: 2, supplement: 0, over48h: 0, today: 0 }, industries: [], total: 2, nextCursor: null,
      kpi: { pending: 2, needsReview: 2, clear: 0, supplement: 0, over48h: 0, receivedToday: 0, approvedToday: 0, autoApprovedToday: 0, rejectedToday: 0, avgHandlingHours: { thisWeek: null, lastWeek: null } },
      applications,
    } };
    if (url.pathname === "/api/admin/sellers/a/notes") return ++attempts === 1 ? { status: 404, json: { error: "not_found" } } : { json: { notes: [{ id: "note-a", body: "첫 행 메모", author: { name: "검증 담당자" }, createdAt: at }] } };
    if (url.pathname === "/api/admin/sellers/b/notes") { await wait; return { json: { notes: [] } }; }
  });
  await page.goto("/admin/partners/applications");
  await page.getByTestId("application-row").first().getByRole("link", { name: "상세", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/partners\/applications\/a(?:\?|$)/);
  const panel = page.locator('section[aria-labelledby="application-memo"]');
  await expect(panel).toContainText("메모를 불러오지 못했어요");
  await panel.getByRole("button", { name: "다시 시도" }).click();
  await expect(panel.getByTestId("application-note")).toHaveText(/첫 행 메모/);
  await page.getByTestId("application-nav").getByRole("button", { name: "다음", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/partners\/applications\/b(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "가입 신청 상세 · 검증 b", exact: true })).toBeVisible();
  await expect(panel.getByTestId("application-note")).toHaveCount(0);
  await expect(panel).toContainText("메모를 불러오고 있어요");
  release();
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByTestId("application-note")).toHaveCount(0);
  expect(result.writes).toEqual([]); expect(result.errors).toEqual([]);
});
