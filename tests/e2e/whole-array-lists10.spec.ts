import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";
import type { AdminPlan } from "../../app/(admin)/admin/_components/messageFees";

// 기존 CI job의 로그인만 재사용하고 목록·순서·삭제 응답은 이 시험 소유 합성 배열에 한정한다.
const run = randomBytes(6).toString("hex");
const email = `array-${run}@example.com`;
const password = randomBytes(12).toString("base64url");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = `tests/e2e/screenshots/current-shell-${sha}`;
let db: PrismaClient;
let adminId: string | undefined;
let baselinePlans: Awaited<ReturnType<PrismaClient["subscriptionPlan"]["findMany"]>> = [];
const ownedPlanIds: string[] = [];
test.beforeAll(async ({}, info) => {
  expect(process.env.CI).toBe("true");
  expect(["e2e-smoke", "e2e-full"]).toContain(process.env.GITHUB_JOB);
  expect(process.env.NODE_ENV).not.toBe("production");
  expect(info.config.workers).toBe(1);
  const url = assertTestDatabaseUrl(process.env.DATABASE_URL);
  expect(new URL(url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(new URL(url).pathname).toBe("/live_obs_test");
  const base = new URL(String(info.project.use.baseURL));
  expect(base.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(base.port).toBe("3100");
  expect(process.env.E2E_PASSWORD).toBeTruthy();
  db = new PrismaClient({ datasources: { db: { url } } });
  adminId = (await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "배열 조회", role: "READ_ONLY" } })).id;
  baselinePlans = await db.subscriptionPlan.findMany({ orderBy: { code: "asc" } });
  for (let i = 0; i < 23; i++) ownedPlanIds.push((await db.subscriptionPlan.create({ data: { code: `ARRAY_${run}_${String(i).padStart(2, "0")}`, name: `합성 요금제 ${i}`, listPrice: 1000 + i, salePrice: 900 + i, trialDays: 0, trialMessageLimit: 0, trialIdentityLimit: 0, trialStorageMb: 0, mailMonthlyQuota: i } })).id);
  mkdirSync(evidence, { recursive: true });
});
test.afterAll(async () => {
  if (!db) return;
  try {
    await db.subscriptionPlan.deleteMany({ where: { id: { in: ownedPlanIds } } });
    if (baselinePlans.length) expect(await db.subscriptionPlan.findMany({ orderBy: { code: "asc" } })).toEqual(baselinePlans);
    if (adminId) {
      await db.adminSession.deleteMany({ where: { adminId } });
      await db.platformAdmin.deleteMany({ where: { id: adminId } });
    }
  } finally { await db.$disconnect(); }
});
async function login(page: Page, admin = false) {
  await page.goto(admin ? "/admin/login" : "/seller/login");
  if (admin) {
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호").fill(password);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
  } else {
    await submitSellerLogin(page, "demo-owner@example.com", process.env.E2E_PASSWORD!);
    await expect(page).toHaveURL(/\/seller$/);
  }
}
async function capture(page: Page, id: string, role: string, state: string) {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector("main.main");
    return { innerWidth, innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null, scrollY, main: main ? { rect: main.getBoundingClientRect().toJSON(), clientWidth: main.clientWidth, scrollWidth: main.scrollWidth } : null };
  });
  const name = `${id}-array10-${metrics.innerWidth}-${state}`;
  await page.screenshot({ path: `tests/e2e/screenshots/${name}.png`, fullPage: true });
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify({ actualGitSha: sha, role, state, route: page.url(), fixture: "current-job-owned-synthetic-array", browserZoom: "UNVERIFIED", metrics }, null, 2));
  expect(metrics.main).not.toBeNull();
}
async function pages(page: Page, rowId: string, selector: string, labels: string[]) {
  const rows = page.getByTestId(rowId);
  const nav = page.getByRole("navigation", { name: "페이지 이동", exact: true });
  const count = Math.ceil(labels.length / 10);
  for (let n = 1; n <= count; n++) {
    await expect(rows).toHaveCount(Math.min(10, labels.length - (n - 1) * 10));
    await expect(rows.locator(selector)).toHaveText(labels.slice((n - 1) * 10, n * 10));
    await expect(nav.getByRole("button", { name: `${n}페이지`, exact: true })).toHaveAttribute("aria-current", "page");
    if (n < count) await nav.getByRole("button", { name: "다음", exact: true }).click();
  }
  await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await nav.getByRole("button", { name: "처음", exact: true }).click();
  await expect(rows.locator(selector)).toHaveText(labels.slice(0, 10));
  await nav.getByRole("button", { name: "마지막", exact: true }).click();
  await nav.getByRole("button", { name: "이전", exact: true }).click();
  await expect(rows.locator(selector)).toHaveText(labels.slice((count - 2) * 10, (count - 1) * 10));
}
test("MA-021: 전체 catalog와 owned 설정을 보존하며 10개·끝·한 쪽 숨김을 표시한다", async ({ page }) => {
  try {
    await login(page, true);
    const actual = await page.request.get("/api/admin/plans"); expect(actual.status()).toBe(200);
    const { plans }: { plans: AdminPlan[] } = await actual.json();
    const expectedCodes = (await db.subscriptionPlan.findMany({ orderBy: { code: "asc" } })).map(p => p.code);
    expect(plans.map(p => p.code)).toEqual(expectedCodes);
    expect(plans).toHaveLength(baselinePlans.length + ownedPlanIds.length);
    for (const original of baselinePlans) expect(plans.find(p => p.code === original.code)).toBeDefined();
    await page.goto("/admin/billing/plans");
    await pages(page, "plan-row", "h2", plans.map(p => p.name));
    await expect(page.getByRole("button", { name: "가격 변경", exact: true })).toHaveCount(0);
    await expect(page.getByText(`전체 요금제 ${plans.length}개`, { exact: true })).toBeVisible();
    for (const width of [1440, 1024]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "MA-021", "READ_ONLY", "page2-real-catalog"); }
    // 한 쪽 표시 경계는 GET 합성 응답으로만 확인하며 catalog 행은 바꾸지 않는다.
    let shownPlans = plans.slice(0, 10);
    await page.route("**/api/admin/plans", route => { expect(route.request().method()).toBe("GET"); return route.fulfill({ json: { plans: shownPlans } }); });
    await page.reload(); await expect(page.getByTestId("plan-row")).toHaveCount(10);
    await expect(page.getByRole("navigation", { name: "페이지 이동", exact: true })).toHaveCount(0);
    shownPlans = []; await page.reload();
    await expect(page.getByText("등록된 요금제가 없습니다.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("plan-row")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "페이지 이동", exact: true })).toHaveCount(0);
  } catch (error) { try { await capture(page, "MA-021", "READ_ONLY", "failed"); } catch {} throw error; }
});
test("SA-006: 전체 연결 배열과 상태·관리 동작을 보존하며 10개씩 표시한다", async ({ page }) => {
  let connections = Array.from({ length: 23 }, (_, i) => ({ id: `synthetic-${i}`, shopKey: `합성 상점 ${i}`, status: "CONNECTED", connectedAt: "2026-10-01T00:00:00Z", lastEventAt: null }));
  await page.route("**/api/seller/external-shops", route => { expect(route.request().method()).toBe("GET"); return route.fulfill({ json: { enabled: true, canManage: true, connections } }); });
  try {
    await login(page); await page.goto("/seller/external-shops");
    await pages(page, "external-row", "td:first-child > b", connections.map(c => c.shopKey));
    await expect(page.getByText("전체 연결 23곳", { exact: true })).toBeVisible();
    await expect(page.getByTestId("external-row").getByRole("button", { name: "연결 해제", exact: true })).toHaveCount(10);
    for (const width of [1440, 1024]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "SA-006", "seeded-owner", "page2"); }
    connections = []; await page.reload();
    await expect(page.getByTestId("external-empty")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "페이지 이동", exact: true })).toHaveCount(0);
  } catch (error) { try { await capture(page, "SA-006", "seeded-owner", "failed"); } catch {} throw error; }
});
test("SA-065: 페이지 경계 순서 변경은 전체 ID를 저장하고 삭제 뒤 쪽을 보정한다", async ({ page }) => {
  let popups = Array.from({ length: 11 }, (_, i) => ({ id: `synthetic-${i}`, kind: "TEXT", title: `합성 팝업 ${i}`, body: "합성 조회", image: null, linkUrl: null, linkLabel: null, startsAt: null, endsAt: null, target: "HOME", position: "CENTER", showOnPc: true, showOnMobile: true, dismissDays: 1, endsAtBroadcastStart: false, hideDuringLive: false, isActive: true, sortOrder: i, status: "live", stats: { impressions: 0, closes: 0, clicks: 0 }, closeRate: null }));
  const originalIds = popups.map(p => p.id);
  const reorders: string[][] = [];
  await page.route("**/api/seller/shop-content/popups**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === "GET" && path === "/api/seller/shop-content/popups") return route.fulfill({ json: { popups, popupsPaused: false, pausedAt: null, pausedByName: null } });
    if (req.method() === "PUT" && path.endsWith("/reorder")) {
      const ids: string[] = req.postDataJSON().ids;
      expect(ids).toHaveLength(11); expect([...ids].sort()).toEqual([...originalIds].sort());
      reorders.push(ids); const next = ids.map(id => popups.find(p => p.id === id));
      if (next.some(p => !p)) throw new Error("unknown synthetic popup");
      popups = next.filter(p => p !== undefined); return route.fulfill({ json: { ok: true } });
    }
    if (req.method() === "DELETE" && path === "/api/seller/shop-content/popups/synthetic-9") { popups = popups.filter(p => p.id !== "synthetic-9"); return route.fulfill({ json: { ok: true } }); }
    throw new Error(`unexpected synthetic request ${req.method()} ${path}`);
  });
  try {
    await login(page); await page.goto("/seller/banners/popups");
    const rows = page.getByTestId("popup-row"), nav = page.getByRole("navigation", { name: "페이지 이동", exact: true });
    await expect(rows).toHaveCount(10); await nav.getByRole("button", { name: "다음", exact: true }).click();
    await expect(rows).toHaveCount(1); await expect(rows.locator("td:first-child > b")).toHaveText("합성 팝업 10");
    await rows.getByRole("button", { name: "합성 팝업 10 위로", exact: true }).click();
    await expect.poll(() => reorders).toEqual([[...originalIds.slice(0, 9), originalIds[10], originalIds[9]]]);
    await expect(rows.locator("td:first-child > b")).toHaveText("합성 팝업 9");
    await expect(page.getByText("팝업 11개 · 게시 중 11", { exact: true })).toBeVisible();
    for (const width of [1440, 1024]) { await page.setViewportSize({ width, height: 900 }); await capture(page, "SA-065", "seeded-owner", "reordered-page2"); }
    await rows.getByRole("button", { name: "수정", exact: true }).click();
    await page.getByTestId("popup-editor").getByRole("button", { name: "팝업 삭제", exact: true }).click();
    await page.getByRole("dialog", { name: "팝업을 삭제하시겠습니까?", exact: true }).getByRole("button", { name: "삭제", exact: true }).click();
    await expect(rows).toHaveCount(10); await expect(nav).toHaveCount(0);
    await expect(rows.locator("td:first-child > b")).toHaveText(popups.map(p => p.title));
    await page.reload(); await expect(rows).toHaveCount(10);
    await expect(rows.locator("td:first-child > b")).toHaveText(popups.map(p => p.title));
    await expect(nav).toHaveCount(0);
    popups = []; await page.reload();
    await expect(page.getByText("등록한 팝업이 없습니다", { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(0);
    await expect(nav).toHaveCount(0);
  } catch (error) { try { await capture(page, "SA-065", "seeded-owner", "failed"); } catch {} throw error; }
});
