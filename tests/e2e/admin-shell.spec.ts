import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import type { AuditDetail, AuditRow } from "../../app/(admin)/admin/_components/auditLogs";

// 마스터 관리자 카페24식 틀: 청록 GNB·LNB, 역할별 메뉴 노출 차이, 로그인 → 홈 진입, 준비 중 화면.
// 마스터 관리자 계정은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { super: `shell-super-${run}@example.com`, cs: `shell-cs-${run}@example.com` };

test.beforeAll(async () => {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const passwordHash = await hashPassword(password);
    await db.platformAdmin.createMany({
      data: [
        { email: emails.super, passwordHash, name: "대표", role: "SUPER_ADMIN" },
        { email: emails.cs, passwordHash, name: "상담", role: "CS" },
      ],
    });
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
          rows: await page.getByTestId("audit-row").count(),
        });
      } catch {
        console.info("MA-070 보조 진단 미확보", { width, browserStatus, responseRows });
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
