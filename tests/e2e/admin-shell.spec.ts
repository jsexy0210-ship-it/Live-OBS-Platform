import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import type { AuditDetail, AuditRow } from "../../app/(admin)/admin/_components/auditLogs";
import type { InquiryCounts, InquiryRow } from "../../app/(admin)/admin/_components/inquiries";
import { NOTIFY_EVENTS } from "../../lib/server/admin/notificationSettings";

// 마스터 관리자 카페24식 틀: 청록 GNB·LNB, 역할별 메뉴 노출 차이, 로그인 → 홈 진입, 준비 중 화면.
// 마스터 관리자 계정은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { super: `shell-super-${run}@example.com`, cs: `shell-cs-${run}@example.com`, viewer: `shell-viewer-${run}@example.com` };
let privateAlertId: string;

test.beforeAll(async () => {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const passwordHash = await hashPassword(password);
    await db.platformAdmin.createMany({
      data: [
        { email: emails.super, passwordHash, name: "대표", role: "SUPER_ADMIN" },
        { email: emails.cs, passwordHash, name: "상담", role: "CS" },
        { email: emails.viewer, passwordHash, name: "조회", role: "READ_ONLY" },
      ],
    });
    privateAlertId = (await db.adminAlert.create({ data: { kind: "INFRA_ALERT", severity: "URGENT", title: "역할별 알림 조회 확인", linkPath: "/admin/support/inquiries", targetRoles: ["SUPER_ADMIN"] } })).id;
  } finally {
    await db.$disconnect();
  }
});

async function login(page: Page, email: string) {
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

const gnb = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });
const lnb = (page: Page) => page.getByRole("complementary", { name: "마스터 관리자 메뉴" });

test("알림 센터: 실제 조회 계약 뒤 합성 요약·규칙·빈 상태를 세 폭에서 확인한다", async ({ page }) => {
  await login(page, emails.super);
  const actual = await page.request.get("/api/admin/alerts");
  expect(actual.status()).toBe(200);
  const actualBody = await actual.json();
  expect(actualBody.items.some((item: { id: string }) => item.id === privateAlertId)).toBe(true);
  for (const status of ["OPEN", "IN_PROGRESS", "RESOLVED"]) expect(typeof actualBody.counts[status]).toBe("number");
  const settings = await page.request.get("/api/admin/settings/notifications");
  expect(settings.status()).toBe(200);
  expect((await settings.json()).routes).toHaveLength(10);
  const mutations: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if ((path.startsWith("/api/admin/alerts") || path === "/api/admin/settings/notifications" || path.startsWith("/api/admin/impersonation")) && !["GET", "HEAD"].includes(request.method())) mutations.push(request.method());
  });
  const positive = { id: "00000000-0000-4000-8000-000000000091", kind: "BROADCAST_DOWN", severity: "URGENT", title: "방송 화면 연결 확인", body: "연결 상태를 확인해 주십시오. ".repeat(8) as string | null, linkPath: "/admin/support/inquiries", shopName: "검수 파트너스" as string | null, occurredAt: "2026-10-10T00:00:00.000Z", assignee: { id: "00000000-0000-4000-8000-000000000092", name: "운영 담당" } as { id: string; name: string } | null, status: "OPEN", unread: true };
  const nullable = { ...positive, body: null, shopName: null, assignee: null };
  let items = [positive];
  let lastQuery = new URLSearchParams();
  await page.route("**/api/admin/alerts**", async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname !== "/api/admin/alerts" || request.method() !== "GET") return route.abort();
    lastQuery = new URL(request.url()).searchParams;
    await route.fulfill({ json: { items, counts: { OPEN: 7, IN_PROGRESS: 4, RESOLVED: 2 }, unreadCount: 9, nextCursor: null } });
  });
  await page.route("**/api/admin/settings/notifications", async (route) => {
    if (route.request().method() !== "GET") return route.abort();
    await route.fulfill({ json: { routes: NOTIFY_EVENTS } });
  });
  for (const state of ["positive", "null", "empty"] as const) {
    items = state === "positive" ? [positive] : state === "null" ? [nullable] : [];
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const [response] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/alerts" && r.request().method() === "GET", { timeout: 5000 }),
        page.goto("/admin/notifications"),
      ]);
      expect(response.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "알림 센터", exact: true })).toBeVisible();
      for (const [status, count] of [["OPEN", 7], ["IN_PROGRESS", 4], ["RESOLVED", 2]] as const) await expect(page.getByTestId(`notification-count-${status}`)).toHaveText(`${count}건`);
      await expect(page.locator(".notification-rule")).toHaveCount(8);
      const keys = ["broadcast_payment_fail_streak", "broadcast_overlay_reconnect_fail", "platform_outage", "payment_callback_stall", "reward_payout_failed", "subscription_payment_failed", "application_overdue_48h", "live_payout_switch_on"];
      const labels = ["URGENT", "WARNING", "INFO"].flatMap((severity) => NOTIFY_EVENTS.filter((event) => event.severity === severity && keys.includes(event.eventKey)).map((event) => event.label));
      expect(labels).toHaveLength(8);
      await expect(page.locator(".notification-rule")).toHaveText(labels);
      await expect(page.getByRole("link", { name: "채널 · 수신자 설정", exact: true })).toHaveAttribute("href", "/admin/settings/notifications");
      await expect(page.locator(".notification-trends strong")).toHaveText(Array(4).fill("집계 준비 중"));
      if (state === "empty") {
        await expect(page.getByText("검색 조건에 맞는 알림이 없습니다.", { exact: true })).toBeVisible();
        await expect(page.getByTestId("notification-row")).toHaveCount(0);
      } else {
        const table = page.getByRole("region", { name: "알림 목록", exact: true }).locator("table");
        await expect(table.getByRole("columnheader")).toHaveText(["심각도", "유형", "파트너스", "내용", "발생", "담당", "상태", "관리"]);
        await expect(table.locator("thead th[scope=col]")).toHaveCount(8);
        await expect(page.getByTestId("notification-row")).toContainText(state === "null" ? "공통" : "검수 파트너스");
        await expect(page.getByTestId("notification-row")).toContainText(state === "null" ? "미배정" : "운영 담당");
        const title = await page.getByTestId("notification-row").locator("strong").boundingBox();
        expect(title && title.width > 0 && title.height > 0).toBe(true);
        await table.locator(".notification-status").evaluate((element) => element.scrollIntoView({ block: "nearest", inline: "nearest" }));
        await expect(table.locator(".notification-status")).toBeVisible();
        await page.locator(".notification-table-scroll").first().evaluate((element) => { element.scrollLeft = 0; });
      }
      if (width === 390) await expect.poll(async () => { const box = await page.locator(".lnb").boundingBox(); return box ? box.x + box.width : Infinity; }).toBeLessThanOrEqual(0);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      if (process.env.E2E_SCREENSHOTS === "1") {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `tests/e2e/screenshots/MA-002-alerts-${state}-${width}.png`, fullPage: true });
      }
    }
  }
  items = [positive];
  await page.goto("/admin/notifications");
  await expect(page.getByTestId("notification-row")).toContainText(positive.title);
  await page.getByLabel("유형", { exact: true }).selectOption("BROADCAST_DOWN");
  items = [];
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("검색 조건에 맞는 알림이 없습니다.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("유형", { exact: true })).toHaveValue("BROADCAST_DOWN");
  await expect(page.getByLabel("유형", { exact: true }).locator('option[value="BROADCAST_DOWN"]')).toHaveCount(1);
  expect(lastQuery.get("kind")).toBe("BROADCAST_DOWN");
  await page.getByRole("checkbox", { name: "해결됨", exact: true }).check();
  await page.getByRole("checkbox", { name: "긴급", exact: true }).uncheck();
  await page.getByPlaceholder("쇼핑몰 이름", { exact: true }).fill("검수 파트너스");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect.poll(() => lastQuery.get("status")).toBe("OPEN,IN_PROGRESS,RESOLVED");
  expect(lastQuery.get("severity")).toBe("WARNING,INFO");
  expect(lastQuery.get("seller")).toBe("검수 파트너스");
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await expect.poll(() => lastQuery.get("status")).toBe("OPEN,IN_PROGRESS");
  expect(lastQuery.get("severity")).toBe("URGENT,WARNING,INFO");
  expect(lastQuery.has("seller")).toBe(false);
  expect(lastQuery.has("kind")).toBe(false);
  await expect(page.getByLabel("유형", { exact: true })).toHaveValue("");
  expect(mutations).toEqual([]);
});

test("알림 센터: 조회 전용은 역할별 알림만 조회하고 개인 읽음과 상태 변경 권한을 구분한다", async ({ page }) => {
  await login(page, emails.viewer);
  const response = await page.request.get("/api/admin/alerts");
  expect(response.status()).toBe(200);
  expect((await response.json()).items.some((item: { id: string }) => item.id === privateAlertId)).toBe(false);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/admin/alerts") && !["GET", "HEAD"].includes(request.method())) mutations.push(request.method());
  });
  await page.route("**/api/admin/alerts**", (route) => route.request().method() === "GET" ? route.fulfill({ json: { items: [{ id: "00000000-0000-4000-8000-000000000093", kind: "INFRA_ALERT", severity: "INFO", title: "전체 역할 알림", body: null, linkPath: "/admin/support/inquiries", shopName: null, occurredAt: "2026-10-10T00:00:00.000Z", assignee: null, status: "OPEN", unread: true }], counts: { OPEN: 1, IN_PROGRESS: 0, RESOLVED: 0 }, unreadCount: 1, nextCursor: null } }) : route.abort());
  await page.route("**/api/admin/settings/notifications", (route) => route.request().method() === "GET" ? route.fulfill({ json: { routes: NOTIFY_EVENTS } }) : route.abort());
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/admin/notifications");
    await expect(page.getByTestId("notification-row")).toContainText("전체 역할 알림");
    await expect(page.getByRole("button", { name: "모두 확인 처리", exact: true })).toBeEnabled();
    await expect(page.locator(".notification-status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "담당", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "채널 · 수신자 설정", exact: true })).toHaveCount(0);
    if (width === 390) await expect.poll(async () => { const box = await page.locator(".lnb").boundingBox(); return box ? box.x + box.width : Infinity; }).toBeLessThanOrEqual(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `tests/e2e/screenshots/MA-002-alerts-readonly-${width}.png`, fullPage: true });
  }
  expect(mutations).toEqual([]);
});

test("로그 추적: 실제 조회 DTO 뒤 합성 IP·기기/빈 값을 목록·상세 세 폭에서 확인한다", async ({ page }) => {
  await login(page, emails.super);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/admin/audit-logs") && !["GET", "HEAD"].includes(request.method())) mutations.push(request.method());
  });
  const listResponse = await page.request.get("/api/admin/audit-logs?limit=50");
  expect(listResponse.status()).toBe(200);
  const actual = await listResponse.json() as { logs: AuditRow[] };
  expect(actual.logs.length).toBeGreaterThan(0);
  const source = actual.logs[0];
  for (const row of actual.logs) {
    expect(row).toHaveProperty("userAgent");
    expect(row.userAgent === null || typeof row.userAgent === "string").toBe(true);
    expect(row).not.toHaveProperty("before");
    expect(row).not.toHaveProperty("after");
  }
  const detailResponse = await page.request.get(`/api/admin/audit-logs/${source.id}`);
  expect(detailResponse.status()).toBe(200);
  const actualDetail = (await detailResponse.json() as { log: AuditDetail }).log;
  expect(actualDetail).toMatchObject({ id: source.id, ip: source.ip, userAgent: source.userAgent });

  // 문서용 IP·긴 UA·별표 입력은 UI 합성값이며 서버 마스킹/실기기 판정의 증거가 아니다.
  const agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 " + "existing-user-agent-".repeat(8);
  const positive: AuditRow = { ...source, createdAt: "2026-10-10T00:00:00.000Z", actorType: "SYSTEM", actorId: null, action: "auth.admin.login", targetType: null, targetId: null, reason: null, seller: null, ip: "192.0.2.17", userAgent: agent };
  const empty = { ...positive, id: "00000000-0000-4000-8000-000000000001", ip: null, userAgent: null };
  const masked = { ...positive, id: "00000000-0000-4000-8000-000000000002", ip: "192.0.2.***", userAgent: "agent-***" };
  let rows: AuditRow[] = [positive, empty, masked];
  let detail: AuditDetail = { ...positive, before: null, after: null, actorAdmin: null };
  await page.route("**/api/admin/audit-logs**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method())) return route.abort();
    if (path === "/api/admin/audit-logs") return route.fulfill({ json: { logs: rows, nextCursor: null } });
    if (path === `/api/admin/audit-logs/${source.id}`) return route.fulfill({ json: { log: detail } });
    return route.abort();
  });
  const text = `${positive.ip} · ${agent}`;
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    let browserStatus: number | null = null;
    let responseRows: number | null = null;
    try {
      const [response] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/audit-logs" && r.request().method() === "GET", { timeout: 5000 }),
        page.goto("/admin/logs"),
      ]);
      browserStatus = response.status();
      const body = await response.json() as { logs?: unknown[] };
      responseRows = Array.isArray(body.logs) ? body.logs.length : null;
      expect(browserStatus).toBe(200);
      expect(responseRows).toBe(3);
      await expect(page.getByRole("columnheader", { name: "IP · 기기", exact: true })).toBeVisible();
      await expect(page.locator(".main .tbl thead").getByRole("columnheader")).toHaveCount(8);
      expect(await page.locator(".main .tbl thead th").evaluateAll((headers) => headers.map((header) => header.getAttribute("scope")))).toEqual(Array(8).fill("col"));
    } catch (error) {
      let roleStatus: number | null = null;
      let role: string | undefined;
      try {
        const me = await page.request.get("/api/admin/me", { timeout: 2000 });
        roleStatus = me.status();
        role = (await me.json() as { role?: string }).role;
      } catch {
        // 역할 조회가 실패해도 화면 구조 진단과 원래 단언 실패는 보존한다.
      }
      try {
        const pathname = new URL(page.url()).pathname;
        console.info("MA-070 목록 실패 경계", {
          width, page: ["/admin", "/admin/logs", "/admin/login"].includes(pathname) ? pathname : "other",
          api: "/api/admin/audit-logs", browserStatus, responseRows, roleStatus,
          role: ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"].includes(role ?? "") ? role : "unavailable",
          loading: await page.locator('[aria-busy="true"]').count(),
          error: await page.getByText("로그를 불러오지 못했습니다.", { exact: true }).count(),
          noAccess: await page.getByTestId("admin-no-access").count(),
          tables: await page.locator(".main .tbl").count(), headers: await page.locator(".main .tbl thead th").count(),
          connectionHeader: await page.getByRole("columnheader", { name: "IP · 기기", exact: true }).count(),
          // 머리글은 정적 라벨만 포함한다. tbody의 실데이터와 속성은 진단하지 않는다.
          headerDOM: await page.locator(".main .tbl thead th").evaluateAll((headers) => headers.map((header) => ({
            textContent: header.textContent, role: header.getAttribute("role"), scope: header.getAttribute("scope"),
            ariaLabel: header.getAttribute("aria-label"), ariaHidden: header.getAttribute("aria-hidden"),
          }))),
          headerRoles: {
            columnheader: await page.locator(".main .tbl thead").getByRole("columnheader").count(),
            rowheader: await page.locator(".main .tbl thead").getByRole("rowheader").count(),
            cell: await page.locator(".main .tbl thead").getByRole("cell").count(),
          },
          rows: await page.getByTestId("audit-row").count(),
        });
      } catch {
        console.info("MA-070 보조 진단 미확보", { width, browserStatus, responseRows });
      }
      try {
        console.info("MA-070 정적 머리글 접근 이름", await page.locator(".main .tbl thead").ariaSnapshot({ timeout: 2000 }));
      } catch {
        console.info("MA-070 머리글 접근 이름 미확보", { width });
      }
      // 실패 화면의 실데이터·계정·입력값은 가리고 구조/헤더/오류만 기존 PNG lane에 남긴다.
      try {
        await page.screenshot({ path: `tests/e2e/screenshots/MA-070-connection-failure-${width}.png`, fullPage: true, timeout: 5000, mask: [page.locator(".gnb"), page.locator(".tbl tbody"), page.locator("input")] });
      } catch {
        console.info("MA-070 실패 PNG 미확보", { width });
      }
      throw error;
    }
    const items = page.getByTestId("audit-row");
    await expect(items).toHaveCount(3);
    const cell = items.first().getByRole("cell").nth(6);
    await expect(cell).toHaveText(text);
    await expect(items.nth(1).getByRole("cell").nth(6)).toHaveText("-");
    await expect(items.nth(2).getByRole("cell").nth(6)).toHaveText("192.0.2.*** · agent-***");
    const link = items.first().getByRole("link", { name: "보기", exact: true });
    await expect(link).toHaveAttribute("href", `/admin/logs/${source.id}`);
    await link.scrollIntoViewIfNeeded();
    const linkBounds = await link.boundingBox();
    expect(linkBounds).not.toBeNull();
    expect(linkBounds!.x).toBeGreaterThanOrEqual(0);
    expect(linkBounds!.x + linkBounds!.width).toBeLessThanOrEqual(width);
    await cell.scrollIntoViewIfNeeded();
    await capture("MA-070", cell);

    await page.goto(`/admin/logs/${source.id}`);
    const label = page.locator("dt").filter({ hasText: /^IP · 기기$/ });
    await expect(label).toHaveCount(1);
    const value = label.locator("+ dd");
    await expect(value).toHaveText(text);
    await expect(page.getByText("접속 주소", { exact: true })).toHaveCount(0);
    await expect(page.locator("dt").filter({ hasText: /^브라우저$/ })).toHaveCount(0);
    await capture("MA-071", value);
  }
  for (const entry of [empty, masked]) {
    detail = { ...entry, before: null, after: null, actorAdmin: null };
    await page.goto(`/admin/logs/${source.id}`);
    await expect(page.locator("dt").filter({ hasText: /^IP · 기기$/ }).locator("+ dd")).toHaveText(entry === empty ? "-" : "192.0.2.*** · agent-***");
  }
  rows = [];
  await page.goto("/admin/logs");
  await expect(page.getByText("아직 기록이 없습니다.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("audit-row")).toHaveCount(0);
  expect(mutations).toEqual([]);

  async function capture(screen: string, value: ReturnType<Page["locator"]>) {
    if (page.viewportSize()!.width === 390) await expect.poll(async () => {
      const menu = await lnb(page).boundingBox();
      return menu ? menu.x + menu.width : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(0);
    await page.evaluate(() => document.fonts.ready);
    const rect = await value.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { width: text.width, height: text.height, left: text.left, right: text.right, top: text.top, bottom: text.bottom, boxLeft: box.left, boxRight: box.right, boxTop: box.top, boxBottom: box.bottom };
    });
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(rect.left).toBeGreaterThanOrEqual(rect.boxLeft);
    expect(rect.right).toBeLessThanOrEqual(rect.boxRight);
    expect(rect.top).toBeGreaterThanOrEqual(rect.boxTop);
    expect(rect.bottom).toBeLessThanOrEqual(rect.boxBottom);
    const bounds = await value.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `tests/e2e/screenshots/${screen}-connection-${page.viewportSize()!.width}.png`, fullPage: true });
  }
});

test("로그 추적: CS의 실제 목록·상세 조회는 403이며 접속 정보가 보이지 않는다", async ({ page }) => {
  await login(page, emails.cs);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/admin/audit-logs") && !["GET", "HEAD"].includes(request.method())) mutations.push(request.method());
  });
  const detail = "/api/admin/audit-logs/00000000-0000-4000-8000-000000000001";
  for (const path of ["/api/admin/audit-logs", detail]) expect((await page.request.get(path)).status()).toBe(403);
  for (const path of ["/admin/logs", "/admin/logs/00000000-0000-4000-8000-000000000001"]) {
    await page.goto(path);
    await expect(page.getByTestId("admin-no-access")).toBeVisible();
    await expect(page.getByTestId("audit-row")).toHaveCount(0);
    await expect(page.getByText("IP · 기기", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/192\.0\.2\.|existing-user-agent|agent-\*\*\*/)).toHaveCount(0);
  }
  expect(mutations).toEqual([]);
});

test("다른 파트너스 대신보기 안내: 세션 상태만 모의하고 실제 로그인·파트너스 조회 후 세 폭 문구를 확인한다", async ({ page }) => {
  type Active = { sellerId: string; shopName: string; slug: string; reason: string; startedAt: string; expiresAt: string };
  let active: Active | null = null;
  const mutations: string[] = [];
  let sessionGets = 0;
  // GET도 만료 세션을 닫을 수 있어 첫 요청부터 전부 모의한다. 실제 세션 API로 넘기지 않는다.
  await page.route(/\/api\/admin\/impersonation(?:\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") {
      mutations.push(route.request().method());
      return route.abort();
    }
    sessionGets++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ active }) });
  });
  await page.route(/\/api\/admin\/sellers\/[^/]+\/impersonate(?:\?.*)?$/, (route) => {
    mutations.push(route.request().method());
    return route.abort();
  });
  await login(page, emails.super);
  await page.goto("/admin/partners");
  const partnerLink = page.getByTestId("partner-row").first().getByRole("link").first();
  await expect(partnerLink).toBeVisible();
  const href = await partnerLink.getAttribute("href");
  expect(href).toMatch(/^\/admin\/partners\/[^/?]+$/);
  const sellerId = href!.split("/").pop()!;
  const detail = await page.request.get(`/api/admin/sellers/${encodeURIComponent(sellerId)}`);
  expect(detail.status()).toBe(200);
  const { seller } = await detail.json() as { seller: { id: string; shopName: string; slug: string } };
  expect(seller.id).toBe(sellerId);
  const other: Active = { sellerId: "ma016-other-partner", shopName: "이름 보존 확인몰", slug: "ma016-other-partner", reason: "다른 파트너스 문의 확인", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  expect(other.sellerId).not.toBe(seller.id);
  active = other;
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(href!);
    await expect(page.getByTestId("partner-badges")).toContainText(seller.shopName);
    const strip = page.getByTestId("impersonation-active");
    const label = strip.locator("b");
    await expect(label).toHaveText(`${other.shopName} 화면을 대신 보는 중입니다.`);
    await expect(strip).toContainText(other.reason);
    await expect(strip).not.toContainText("대리 조회 중입니다.");
    if (width === 390) await expect.poll(async () => {
      const menu = await lnb(page).boundingBox();
      return menu ? menu.x + menu.width : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(0);
    await page.evaluate(() => document.fonts.ready);
    const rect = await label.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const strip = el.parentElement!.getBoundingClientRect();
      return { width: text.width, height: text.height, left: text.left, right: text.right, top: text.top, bottom: text.bottom, stripLeft: strip.left, stripRight: strip.right, stripTop: strip.top, stripBottom: strip.bottom };
    });
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(rect.left).toBeGreaterThanOrEqual(rect.stripLeft);
    expect(rect.right).toBeLessThanOrEqual(rect.stripRight);
    expect(rect.top).toBeGreaterThanOrEqual(rect.stripTop);
    expect(rect.bottom).toBeLessThanOrEqual(rect.stripBottom);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `tests/e2e/screenshots/MA-016-other-session-${width}.png`, fullPage: true });
  }
  active = { ...other, sellerId: seller.id, shopName: seller.shopName, slug: seller.slug };
  await page.goto(href!);
  await expect(page.getByTestId("impersonation-active").locator("b")).toHaveText("이 파트너스 화면을 대신 보는 중입니다.");
  active = null;
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/impersonation" && r.request().method() === "GET"),
    page.goto(href!),
  ]);
  await expect(page.getByTestId("partner-badges")).toContainText(seller.shopName);
  await expect(page.getByTestId("impersonation-active")).toHaveCount(0);
  expect(sessionGets).toBeGreaterThanOrEqual(5);
  expect(mutations).toEqual([]);
});

test("파트너스 문의: 실제 요약·긴급 조건을 조회하고 합성 요약/준비 중/빈 상태를 세 폭에서 확인한다", async ({ page }) => {
  await login(page, emails.cs);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/admin/platform-inquiries") && !["GET", "HEAD"].includes(request.method())) mutations.push(request.method());
  });
  type Summary = { waiting: number; urgent: number; overdue: number; mine: number; todayReceived: number; answeredToday: number; avgFirstReplyHours: number | null; helpful7d: { answered: number; helpful: number; rate: number | null } };
  type Body = { items: InquiryRow[]; counts: InquiryCounts; summary: Summary; nextCursor: string | null };
  const responseFor = (urgent: string | null) => page.waitForResponse((r) => {
    const url = new URL(r.url());
    return url.pathname === "/api/admin/platform-inquiries" && url.searchParams.get("urgent") === urgent && r.request().method() === "GET";
  });
  for (const urgent of ["first", "only", ""] as const) {
    const [response] = await Promise.all([responseFor(urgent || null), page.goto(`/admin/support/inquiries?urgent=${urgent}`)]);
    expect(response.status()).toBe(200);
    const body = await response.json() as Body;
    for (const key of ["waiting", "urgent", "overdue", "mine", "todayReceived", "answeredToday"] as const) {
      expect(Number.isInteger(body.summary[key])).toBe(true);
      expect(body.summary[key]).toBeGreaterThanOrEqual(0);
    }
    expect(body.summary.avgFirstReplyHours === null || Number.isFinite(body.summary.avgFirstReplyHours)).toBe(true);
    if (urgent === "only") expect(body.items.every((row) => row.urgent === true)).toBe(true);
    if (urgent === "first") expect(body.items.map((row) => Boolean(row.urgent))).toEqual(body.items.map((row) => Boolean(row.urgent)).sort((a, b) => Number(b) - Number(a)));
    await summaryValues(body.summary);
  }
  await page.getByLabel("긴급만", { exact: true }).check();
  const [only] = await Promise.all([responseFor("only"), page.getByRole("button", { name: "검색", exact: true }).click()]);
  expect(only.status()).toBe(200);
  expect(new URL(page.url()).searchParams.get("urgent")).toBe("only");
  await summaryValues((await only.json() as Body).summary);
  await expect(page.getByLabel("긴급 우선", { exact: true })).not.toBeChecked();
  const [reset] = await Promise.all([responseFor("first"), page.getByRole("button", { name: "초기화", exact: true }).click()]);
  expect(reset.status()).toBe(200);
  expect(new URL(page.url()).searchParams.has("urgent")).toBe(false);
  await expect(page.getByLabel("긴급 우선", { exact: true })).toBeChecked();
  await page.getByLabel("긴급 우선", { exact: true }).uncheck();
  const [cleared] = await Promise.all([responseFor(null), page.getByRole("button", { name: "검색", exact: true }).click()]);
  expect(cleared.status()).toBe(200);
  expect(new URL(page.url()).searchParams.get("urgent")).toBe("");
  await expect(page.getByLabel("긴급 우선", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("긴급만", { exact: true })).not.toBeChecked();
  await summaryValues((await cleared.json() as Body).summary);

  const sellerId = "00000000-0000-4000-8000-000000000051";
  const row: InquiryRow = { id: sellerId, sellerId, shopName: "조회 시험몰", slug: "summary-fixture", authorName: null, category: "BROADCAST", title: "합성 긴급 문의", status: "OPEN", urgent: true, assignee: null, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString(), lastAdminMessageAt: null, closedAt: null, version: 1 };
  const positive: Body = { items: [row], counts: { OPEN: 2, ANSWERED: 3, CLOSED: 4 }, nextCursor: null, summary: { waiting: 7, urgent: 1, overdue: 2, mine: 4, todayReceived: 14, answeredToday: 9, avgFirstReplyHours: 3.2, helpful7d: { answered: 2, helpful: 1, rate: 50 } } };
  const cases: [string, Body][] = [
    ["positive", positive],
    ["null", { ...positive, summary: { ...positive.summary, avgFirstReplyHours: null, helpful7d: { answered: 1, helpful: 1, rate: 100 } } }],
    ["empty", { items: [], counts: { OPEN: 0, ANSWERED: 0, CLOSED: 0 }, nextCursor: null, summary: { waiting: 0, urgent: 0, overdue: 0, mine: 0, todayReceived: 0, answeredToday: 0, avgFirstReplyHours: null, helpful7d: { answered: 0, helpful: 0, rate: null } } }],
  ];
  let mock = positive;
  const requests: URL[] = [];
  await page.route("**/api/admin/platform-inquiries?**", (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) return route.abort();
    const url = new URL(route.request().url());
    requests.push(url);
    return route.fulfill({ json: url.searchParams.has("cursor") ? { ...mock, items: [{ ...row, id: "00000000-0000-4000-8000-000000000052", title: "합성 다음 문의", urgent: false }], nextCursor: null } : mock });
  });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const [state, body] of cases) {
      mock = body;
      await page.goto("/admin/support/inquiries");
      await summaryValues(body.summary);
      await expect(page.getByTestId("inquiry-row")).toHaveCount(body.items.length);
      if (state === "empty") await expect(page.getByText("답변을 기다리는 문의가 없습니다.", { exact: true })).toBeVisible();
      if (width === 390) await expect.poll(async () => {
        const menu = await lnb(page).boundingBox();
        return menu ? menu.x + menu.width : Number.POSITIVE_INFINITY;
      }).toBeLessThanOrEqual(0);
      await page.evaluate(() => document.fonts.ready);
      const boxes = await page.getByTestId("inquiry-summary").locator(":scope > .card > span").evaluateAll((elements) => elements.map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect();
        const card = el.parentElement!.getBoundingClientRect();
        return { width: text.width, height: text.height, left: text.left, right: text.right, top: text.top, bottom: text.bottom, cardLeft: card.left, cardRight: card.right, cardTop: card.top, cardBottom: card.bottom };
      }));
      for (const box of boxes) {
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(box.left).toBeGreaterThanOrEqual(Math.max(0, box.cardLeft));
        expect(box.right).toBeLessThanOrEqual(Math.min(width, box.cardRight));
        expect(box.top).toBeGreaterThanOrEqual(box.cardTop);
        expect(box.bottom).toBeLessThanOrEqual(box.cardBottom);
      }
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `tests/e2e/screenshots/MA-051-summary-${state}-${width}.png`, fullPage: true });
    }
  }
  // 긴급 우선의 U커서를 그대로 보내고, 재검색·초기화는 파트너스 조건을 유지한다.
  const cursor = `U1_${row.lastMessageAt}_${row.id}`;
  mock = { ...positive, nextCursor: cursor };
  await page.goto(`/admin/support/inquiries?sellerId=${sellerId}`);
  await summaryValues(positive.summary);
  await page.getByRole("button", { name: "더 보기", exact: true }).click();
  await expect(page.getByTestId("inquiry-row")).toHaveCount(2);
  expect(requests.at(-1)!.searchParams.get("cursor")).toBe(cursor);
  expect(requests.at(-1)!.searchParams.get("urgent")).toBe("first");
  expect(requests.at(-1)!.searchParams.get("sellerId")).toBe(sellerId);
  await page.getByLabel("긴급만", { exact: true }).check();
  await Promise.all([responseFor("only"), page.getByRole("button", { name: "검색", exact: true }).click()]);
  await summaryValues(positive.summary);
  expect(new URL(page.url()).searchParams.get("sellerId")).toBe(sellerId);
  await Promise.all([responseFor("first"), page.getByRole("button", { name: "초기화", exact: true }).click()]);
  await summaryValues(positive.summary);
  expect(new URL(page.url()).searchParams.get("sellerId")).toBe(sellerId);
  expect(mutations).toEqual([]);

  async function summaryValues(summary: Summary) {
    const cards = page.getByTestId("inquiry-summary").locator(":scope > .card");
    await expect(cards).toHaveCount(6);
    await expect(cards.locator(":scope > span:first-child")).toHaveText(["답변 대기", "내 담당", "오늘 접수", "답변 완료 (오늘)", "평균 첫 답변", "만족도 (7일)"]);
    await expect(cards.locator(":scope > .t-h2")).toHaveText([`${summary.waiting}건`, `${summary.mine}건`, `${summary.todayReceived}건`, `${summary.answeredToday}건`, summary.avgFirstReplyHours === null ? "—" : `${summary.avgFirstReplyHours.toFixed(1)}시간`, "집계 준비 중"]);
    await expect(cards.first()).toContainText(`긴급 ${summary.urgent} · 4시간 초과 ${summary.overdue}`);
    await expect(cards.last()).not.toContainText(/%|4\.6|평가/);
    await expect(page.getByLabel("긴급 우선", { exact: true })).toBeVisible();
    await expect(page.getByLabel("긴급만", { exact: true })).toBeVisible();
  }
});

for (const role of ["super", "cs"] as const) {
  test(`환불 요청: ${role === "super" ? "최고관리자" : "CS"}의 승인대기 요약을 조회 전용으로 세 폭에서 확인한다`, async ({ page }) => {
    await login(page, emails[role]);
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/admin/subscription-refunds") && !["GET", "HEAD"].includes(request.method())) mutations.push(request.method());
    });
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const [response] = await Promise.all([
        page.waitForResponse((r) => {
          const url = new URL(r.url());
          return url.pathname === "/api/admin/subscription-refunds" && url.searchParams.get("status") === "pending" && r.request().method() === "GET";
        }),
        page.goto("/admin/billing/refunds"),
      ]);
      expect(response.status()).toBe(200);
      const { counts } = await response.json() as { counts: { REQUESTED: number; PROCESSING: number; FAILED: number } };
      expect(Number.isInteger(counts.REQUESTED)).toBe(true);
      expect(counts.REQUESTED).toBeGreaterThanOrEqual(0);
      await expect(page.getByRole("heading", { level: 1, name: "환불 요청", exact: true })).toBeVisible();
      const value = page.getByTestId("refund-requested");
      const tile = value.locator("..");
      const summary = tile.locator("..");
      const label = tile.locator(".t-l2");
      await expect(label).toHaveText("승인 대기 (최고관리자)");
      await expect(value).toHaveText(`${counts.REQUESTED}건`);
      await expect(summary.locator(":scope > .card")).toHaveCount(4);
      await expect(summary.getByText("검토 대기", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("radiogroup", { name: "상태" }).getByRole("radio").first()).toHaveText(`대기 ${counts.REQUESTED + counts.PROCESSING + counts.FAILED}`);
      if (width === 390) await expect.poll(async () => {
        const menu = await lnb(page).boundingBox();
        return menu ? menu.x + menu.width : Number.POSITIVE_INFINITY;
      }).toBeLessThanOrEqual(0);
      await page.evaluate(() => document.fonts.ready);
      const rect = await label.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect();
        const tile = el.parentElement!.getBoundingClientRect();
        return { width: text.width, height: text.height, left: text.left, right: text.right, top: text.top, bottom: text.bottom, tileLeft: tile.left, tileRight: tile.right, tileTop: tile.top, tileBottom: tile.bottom };
      });
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(rect.tileLeft);
      expect(rect.right).toBeLessThanOrEqual(rect.tileRight);
      expect(rect.top).toBeGreaterThanOrEqual(rect.tileTop);
      expect(rect.bottom).toBeLessThanOrEqual(rect.tileBottom);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `tests/e2e/screenshots/MA-026-summary-${role}-${width}.png`, fullPage: true });
    }
    expect(mutations).toEqual([]);
  });
}

test("파트너스 목록: 실제 로그인 후 공통 틀 3폭 geometry와 이번 SHA 캡처를 확인한다", async ({ page }) => {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const captures = [];
  await login(page, emails.super);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/partners");
    await expect(page.getByRole("heading", { name: "파트너스 목록", exact: true })).toBeVisible();
    await expect(page.getByTestId("partner-row").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.evaluate(() => {
      const main = document.querySelector(".main")!.getBoundingClientRect();
      const head = document.querySelector(".au-ph")!.getBoundingClientRect();
      return { mainX: main.x, headY: head.y, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry).toEqual({ mainX: width < 768 ? 0 : 196, headY: 112, overflow: false });
    const path = `tests/e2e/screenshots/current-shell-${sourceSha}/admin-partners-list-${width}.png`;
    const png = await page.screenshot({ path, fullPage: true });
    captures.push({ width, path, geometry, sha256: createHash("sha256").update(png).digest("hex") });
  }
  const manifest = { sourceSha, route: "/admin/partners", state: "CI seeded test DB, authenticated SUPER_ADMIN", captures };
  writeFileSync(`tests/e2e/screenshots/current-shell-${sourceSha}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.info("Current shell captures:", JSON.stringify(manifest));
});

test("최고관리자: 홈 중복 경로는 생략하고 운영 화면의 LNB 제목 줄·경로 줄은 같은 높이를 유지한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, emails.super);
  await expect(gnb(page).getByRole("link")).toHaveText(["홈", "파트너스", "요금 · 결제", "운영", "고객지원", "설정"]);
  await expect(page.getByRole("heading", { name: "통합 대시보드", level: 1 })).toBeVisible();
  // 메뉴 이름은 「홈」, 화면 제목은 「통합 대시보드」
  await expect(lnb(page).getByRole("link", { name: "홈", exact: true })).toHaveAttribute("aria-current", "page");
  const bg = await page.locator(".gnb").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(15, 118, 110)");
  await expect(page.locator(".loc-bar")).toHaveCount(0);
  expect(await page.locator(".lnb-sec.on .lnb-h").evaluate((el) => el.getBoundingClientRect().height)).toBe(48);
  await gnb(page).getByRole("link", { name: "운영" }).click();
  await expect(page.locator(".loc-bar")).toBeVisible();
  const h = await page.evaluate(() => ({ lnb: document.querySelector(".lnb-sec.on .lnb-h")!.getBoundingClientRect().height, loc: document.querySelector(".loc-bar")!.getBoundingClientRect().height }));
  expect(h.lnb).toBe(48);
  expect(h.loc).toBe(48);
  await expect(lnb(page).getByRole("link", { name: "실시간 감시" })).toBeVisible();
  await expect(lnb(page).locator(".lnb-sec.on .lnb-i")).toHaveText(["실시간 방송", "주문 · 방송 화면 접속", "실시간 감시", "자동 연결 작업", "인프라 · 비용"]);
  await expect(lnb(page).getByRole("link", { name: "자동 연결 작업" })).toHaveAttribute("href", "/admin/ops/automation");
  await gnb(page).getByRole("link", { name: "설정" }).click();
  // 설정은 소제목 「시스템」「관리자」로 나뉜다(관리자 그룹은 설정으로 합쳐짐)
  await expect(lnb(page).locator(".lnb-sec.on .lnb-sub")).toHaveText(["시스템", "관리자"]);
  await expect(lnb(page).getByRole("link", { name: "관리자 계정" })).toBeVisible();
  await expect(lnb(page).getByRole("link", { name: "역할별 권한" })).toBeVisible();
  await expect(lnb(page).getByRole("link", { name: "로그 추적" })).toBeVisible();
  await gnb(page).getByRole("link", { name: "파트너스" }).click();
  await expect(lnb(page).locator(".lnb-sec.on .lnb-i")).toHaveText(["파트너스 목록", "가입 신청", "결제 연결 상태", "적립금 실제 지급 켠 파트너스"]);
  await gnb(page).getByRole("link", { name: "요금 · 결제" }).click();
  await expect(lnb(page).locator(".lnb-sec.on .lnb-i")).toHaveText(["요금제", "구독 현황", "청구 · 결제 내역", "구독료 수납", "환불 요청"]);
});

test("CS: 최고관리자 전용 메뉴(설정 대분류=시스템·관리자)와 로그 추적이 숨겨지고, 주소로 들어가도 권한 안내만 보인다. 실시간 감시는 조회로 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, emails.cs);
  await gnb(page).getByRole("link", { name: "운영" }).click();
  await expect(lnb(page).getByRole("link", { name: "실시간 방송" })).toBeVisible();
  await expect(lnb(page).getByRole("link", { name: "실시간 감시" })).toBeVisible();
  await expect(gnb(page).getByRole("link", { name: "설정" })).toHaveCount(0);
  for (const path of ["/admin/logs", "/admin/settings/branding", "/admin/settings/maintenance"]) {
    await page.goto(path);
    const noAccess = page.getByTestId("admin-no-access");
    await expect(noAccess.getByRole("heading", { name: "이 화면을 볼 권한이 없습니다", exact: true })).toBeVisible();
    await expect(noAccess).toContainText("권한이 필요하면 최고관리자에게 요청해 주십시오.");
    await expect(page.getByRole("heading", { name: "파비콘 · 공유 카드" })).toHaveCount(0);
  }
});

test("메뉴에 없는 주소는 관리자 404(합니다체·대시보드로), 화면 있는 메뉴(파비콘·공유 카드)는 그대로 열린다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto("/admin/nothing-here");
  await expect(page.getByTestId("admin-coming-soon")).toHaveCount(0);
  await expect(page.getByTestId("not-found")).toContainText("페이지를 찾을 수 없습니다");
  await expect(page.getByRole("link", { name: "대시보드로" })).toHaveAttribute("href", "/admin");
  await page.goto("/admin/settings/branding");
  await expect(page.getByRole("heading", { name: "파비콘 · 공유 카드" })).toBeVisible();
});

test("마스터 상단: 전역 검색과 알림 버튼이 있고 검색 패널이 열린다", async ({ page }) => {
  await login(page, emails.super);
  await expect(page.getByRole("button", { name: /^알림/ })).toBeVisible();
  await page.getByRole("button", { name: "빠른 찾기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "전체 검색" });
  await dialog.getByRole("searchbox").fill("zzz없는검색어");
  await expect(dialog.getByText("「zzz없는검색어」 검색 결과가 없습니다.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("마스터 상단 「알림」(DS-NAV, 화면 이름은 알림 센터)은 /admin/notifications로 연결되고 종 「모두 보기」도 같은 곳을 가리킨다", async ({ page }) => {
  await login(page, emails.super);
  await expect(page.locator(".util-desk").getByRole("link", { name: "알림", exact: true })).toHaveAttribute("href", "/admin/notifications");
  await page.getByRole("button", { name: /^알림/ }).click();
  await expect(page.getByRole("dialog", { name: "알림" }).getByRole("link", { name: "모두 보기" })).toHaveAttribute("href", "/admin/notifications");
});
