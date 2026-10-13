import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 현재 표준 CI job의 고유 폐기 fixture를 조회한다. 승인·청구·공지 쓰기·방송·자동화 실행은 하지 않는다.
const run = randomBytes(6).toString("hex");
const email = `admin-six-${run}@example.com`;
const password = randomBytes(12).toString("base64url");
const name = `목록 여섯 ${run}`;
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = `tests/e2e/screenshots/current-shell-${sha}`;
let db: PrismaClient;
let adminId: string | undefined;
let ownerId: string | undefined;
let sellerId: string | undefined;
let subscriptionId: string | undefined;
const owned = { sellers: [] as string[], applications: [] as string[], jobs: [] as string[], automationPayments: [] as string[], invoices: [] as string[], logs: [] as string[], notices: [] as string[] };

test.beforeAll(async ({}, info) => {
  expect(process.env.CI).toBe("true");
  expect(process.env.GITHUB_JOB).toBe("e2e-smoke");
  expect(process.env.NODE_ENV).not.toBe("production");
  expect(info.config.workers).toBe(1);
  const url = assertTestDatabaseUrl(process.env.DATABASE_URL);
  expect(new URL(url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(new URL(url).pathname).toBe("/live_obs_test");
  const base = new URL(String(info.project.use.baseURL));
  expect(base.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(base.port).toBe("3100");
  db = new PrismaClient({ datasources: { db: { url } } });
  mkdirSync(evidence, { recursive: true });
  adminId = (await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "목록 조회", role: "READ_ONLY" } })).id;
  sellerId = (await db.seller.create({ data: { slug: `six-${run}`, shopName: name, status: "ACTIVE", approvedAt: new Date() } })).id;
  ownerId = (await db.sellerUser.create({ data: { sellerId, email: `six-owner-${run}@example.com`, passwordHash: "unused", name: "대표", isOwner: true } })).id;
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
  subscriptionId = (await db.sellerSubscription.create({ data: { sellerId, planId: plan.id } })).id;
  const now = new Date();
  for (let i = 0; i < 23; i++) {
    const at = new Date(now.getTime() + 3_600_000 - i * 1000);
    owned.invoices.push((await db.subscriptionPayment.create({ data: { sellerId, subscriptionId, amount: 1000 + i, status: "PAID", periodStart: new Date(now.getTime() - i * 30 * 86_400_000), periodEnd: new Date(now.getTime() + (1 - i) * 30 * 86_400_000), createdAt: now, paidAt: now } })).id);
    owned.logs.push((await db.auditLog.create({ data: { sellerId, actorType: "SYSTEM", action: "admin.billing.export", createdAt: at } })).id);
    owned.notices.push((await db.platformNotice.create({ data: { title: `${name} 공지 ${i}`, body: "고유 합성 조회", category: i === 22 ? "POLICY" : "GENERAL", audience: "ALL", createdByAdminId: adminId, updatedByAdminId: adminId, createdAt: at } })).id);
    owned.applications.push((await db.seller.create({ data: { slug: `six-apply-${run}-${i}`, shopName: `${name} 신청 ${i}`, status: "PENDING", createdAt: at, reviewReasons: [] } })).id);
    const activity = await db.seller.create({ data: { slug: `six-access-${run}-${i}`, shopName: `${name} 접속 ${i}`, status: "ACTIVE", approvedAt: now, createdAt: at } });
    owned.sellers.push(activity.id);
    await db.broadcastSession.create({ data: { sellerId: activity.id, status: "LIVE", title: "합성 조회", startedAt: now } });
    await db.overlayToken.create({ data: { sellerId: activity.id, tokenHash: `six-${run}-${i}`, lastSeenAt: null } });
    const payment = await db.automationPayment.create({ data: { sellerId, amount: 1000, status: "PAID", idempotencyKey: `six-${run}-${i}`, requestFingerprint: `six-${run}-${i}`, consentNoticeVersion: "synthetic", consentAgreedAt: now } });
    owned.automationPayments.push(payment.id);
    owned.jobs.push((await db.automationJob.create({ data: { sellerId, paymentId: payment.id, obsTargetKey: `synthetic-${run}-${i}`, status: "SUCCEEDED", createdAt: at, finishedAt: now } })).id);
  }
});

test.afterAll(async () => {
  if (!db) return;
  try {
    await db.automationJob.deleteMany({ where: { id: { in: owned.jobs } } });
    await db.automationPayment.deleteMany({ where: { id: { in: owned.automationPayments } } });
    await db.subscriptionPayment.deleteMany({ where: { id: { in: owned.invoices } } });
    if (subscriptionId) await db.sellerSubscription.deleteMany({ where: { id: subscriptionId } });
    await db.auditLog.deleteMany({ where: { id: { in: owned.logs } } });
    await db.platformNotice.deleteMany({ where: { id: { in: owned.notices } } });
    await db.broadcastSession.deleteMany({ where: { sellerId: { in: owned.sellers } } });
    await db.overlayToken.deleteMany({ where: { sellerId: { in: owned.sellers } } });
    await db.seller.deleteMany({ where: { id: { in: [...owned.sellers, ...owned.applications] } } });
    if (ownerId && sellerId) await db.sellerUser.deleteMany({ where: { id: ownerId, sellerId } });
    if (sellerId) await db.seller.deleteMany({ where: { id: sellerId } });
    if (adminId) await db.adminSession.deleteMany({ where: { adminId } });
    if (adminId) await db.platformAdmin.deleteMany({ where: { id: adminId } });
  } finally { await db.$disconnect(); }
});

type Row = { id: string; sellerId?: string; title?: string; amount?: number };
type Data = { items?: Row[]; logs?: Row[]; applications?: Row[]; jobs?: Row[]; nextCursor: string | null; total?: number };
const targets = [
  { id: "MA-024", route: "/admin/billing/invoices", api: "/api/admin/billing/invoices", field: "items", row: "invoice-row", link: "/admin/billing/invoices/", query: () => ({ sellerId: sellerId! }), fixture: () => owned.invoices },
  { id: "MA-042", route: "/admin/ops/access", api: "/api/admin/ops/seller-activity", field: "items", row: "activity-row", link: "/admin/partners/", query: () => ({ period: "today", liveOnly: "1", offOnly: "1" }), fixture: () => owned.sellers },
  { id: "MA-053", route: "/admin/support/notices", api: "/api/admin/platform-notices", field: "items", row: "notice-row", link: "", query: () => ({ q: name }), fixture: () => owned.notices },
  { id: "MA-070", route: "/admin/logs", api: "/api/admin/audit-logs", field: "logs", row: "audit-row", link: "/admin/logs/", query: () => ({ sellerId: sellerId! }), fixture: () => owned.logs },
  { id: "MA-013", route: "/admin/partners/applications", api: "/api/admin/sellers/applications", field: "applications", row: "application-row", link: "/admin/partners/applications/", query: () => ({ tab: "all", field: "shop", q: name, sort: "oldest" }), fixture: () => owned.applications },
  { id: "MA-110", route: "/admin/ops/automation", api: "/api/automation/admin/jobs", field: "jobs", row: "automation-job", link: "/admin/ops/automation/", query: () => ({ filter: "done" }), fixture: () => owned.jobs },
] as const;

async function capture(page: Page, id: string, state: string) {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector("main.main");
    const table = document.querySelector("main.main table.tbl");
    return { innerWidth, innerHeight, dpr: devicePixelRatio, visualScale: visualViewport?.scale ?? null, scrollY, main: main ? { width: main.clientWidth, scrollWidth: main.scrollWidth, rect: main.getBoundingClientRect().toJSON() } : null, table: table?.getBoundingClientRect().toJSON() ?? null };
  });
  const filename = `${id}-list10-${metrics.innerWidth}-${state}`;
  await page.screenshot({ path: `tests/e2e/screenshots/${filename}.png`, fullPage: true });
  writeFileSync(`${evidence}/${filename}.json`, JSON.stringify({ actualGitSha: sha, role: "READ_ONLY", state, route: page.url(), fixture: "current-job-owned-synthetic", browserZoom: "UNVERIFIED", metrics, rows: await page.locator("tbody tr").allTextContents() }, null, 2));
  expect(metrics.main).not.toBeNull();
}

for (const target of targets) test(`${target.id}: 실목록 10개·앞뒤·처음·끝과 조회 정보·권한을 보존한다`, async ({ page }) => {
  try {
    await page.goto("/admin/login");
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호").fill(password);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    const params = new URLSearchParams(target.query());
    await page.goto(`${target.route}?${params}`);
    if (target.id === "MA-042") {
      await page.getByRole("checkbox", { name: "방송 중만", exact: true }).check();
      await page.getByRole("checkbox", { name: "방송 화면 연결 안 됨", exact: true }).check();
    }
    const rows = page.getByTestId(target.row);
    const nav = page.getByRole("navigation", { name: "페이지 이동", exact: true });
    const pages: Row[][] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams(target.query());
      if (cursor) query.set("cursor", cursor);
      const response = await page.request.get(`${target.api}?${query}`);
      expect(response.status()).toBe(200);
      const data: Data = await response.json();
      const expected = data[target.field];
      expect(expected).toBeDefined();
      if (!expected) throw new Error("missing list");
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThanOrEqual(10);
      pages.push(expected);
      const check = async () => {
        await expect(rows).toHaveCount(expected.length);
        if (target.id === "MA-053") await expect(rows.locator("span.fw6")).toHaveText(expected.map(r => r.title!));
        else {
          const links = rows.locator(`${["MA-024", "MA-013"].includes(target.id) ? "td:first-child > " : ""}a[href^="${target.link}"]`).filter({ hasText: target.id === "MA-024" ? /구독료/ : target.id === "MA-070" ? /^보기$/ : target.id === "MA-110" ? /^상세$/ : /./ });
          await expect(links).toHaveCount(expected.length);
          const ids = await links.evaluateAll(nodes => nodes.map(node => new URL(node.getAttribute("href") ?? "", location.href).pathname.split("/").pop()));
          expect(ids).toEqual(expected.map(r => target.id === "MA-042" ? r.sellerId : r.id));
        }
        if (target.id === "MA-024") for (const row of expected) await expect(rows.filter({ hasText: `${row.amount!.toLocaleString("ko-KR")}원` })).toHaveCount(1);
      };
      await check();
      if (pages.length === 1) for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        await check();
        await capture(page, target.id, "page1");
      }
      cursor = data.nextCursor ?? undefined;
      if (cursor) {
        expect(seen.has(cursor)).toBe(false); seen.add(cursor);
        await nav.getByRole("button", { name: "다음", exact: true }).evaluate(node => { if (!(node instanceof HTMLButtonElement)) throw new Error("missing next button"); node.click(); node.click(); });
        await expect(nav.getByRole("button", { name: `${pages.length + 1}페이지`, exact: true })).toHaveAttribute("aria-current", "page");
      }
    } while (cursor);
    const ids = pages.flat().map(r => target.id === "MA-042" ? r.sellerId : r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(id => id && target.fixture().includes(id)).sort()).toEqual([...target.fixture()].sort());
    expect(pages[0]).toHaveLength(10);
    expect(pages[1]).toHaveLength(10);
    if (target.id !== "MA-042" && target.id !== "MA-110") expect(pages.map(p => p.length)).toEqual([10, 10, 3]);
    await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
    await nav.getByRole("button", { name: "이전", exact: true }).click();
    await expect(rows).toHaveCount(pages[pages.length - 2].length);
    await nav.getByRole("button", { name: "처음", exact: true }).click();
    await expect(nav.getByRole("button", { name: "1페이지", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(rows).toHaveCount(10);
    if (target.id === "MA-053") {
      await page.getByRole("searchbox", { name: "제목", exact: true }).fill(`${name} 공지 22`);
      await page.getByRole("button", { name: "검색", exact: true }).click();
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText(`${name} 공지 22`);
      await expect(nav).toHaveCount(0);
    }
  } catch (error) {
    try { await capture(page, target.id, "failed"); } catch { /* 최초 오류를 덮지 않는다 */ }
    throw error;
  }
});
