import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

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
