import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { createAdminAlert } from "../../lib/server/admin-alerts/service";

// 현재 CI job의 폐기 DB에서만 고유 행을 만들고 조회한다. 승인·답변·읽음 처리는 실행하지 않는다.
const run = randomBytes(6).toString("hex");
const email = `cursor-read-${run}@example.com`;
const password = randomBytes(12).toString("base64url");
const shopName = `커서몰 ${run}`;
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = `tests/e2e/screenshots/current-shell-${sha}`;
let db: PrismaClient;
let adminId: string | undefined;
let sellerId: string | undefined;
let ownerId: string | undefined;
let subscriptionId: string | undefined;
const owned = { alerts: [] as string[], refunds: [] as string[], inquiries: [] as string[], payments: [] as string[] };

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
  sellerId = (await db.seller.create({ data: { slug: `cursor-${run}`, shopName, status: "ACTIVE", approvedAt: new Date() } })).id;
  const user = await db.sellerUser.create({ data: { sellerId, email: `cursor-owner-${run}@example.com`, passwordHash: "unused", name: "대표", isOwner: true } });
  ownerId = user.id;
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
  subscriptionId = (await db.sellerSubscription.create({ data: { sellerId, planId: plan.id } })).id;
  const start = new Date();
  for (let i = 0; i < 23; i++) {
    const at = new Date(start.getTime() + 3_600_000 - i * 1000);
    owned.inquiries.push((await db.platformInquiry.create({ data: { sellerId, createdBySellerUserId: user.id, category: i === 22 ? "BROADCAST" : "OTHER", title: `커서 문의 ${run}-${i}`, lastMessageAt: at } })).id);
    const alert = await createAdminAlert(db, { kind: "INQUIRY_URGENT", severity: "URGENT", sellerId, title: `커서 알림 ${run}-${i}`, linkPath: `/admin/support/inquiries/${owned.inquiries[i]}`, occurredAt: at });
    expect(alert.created).toBe(true);
    expect(alert.id).not.toBeNull();
    if (alert.id) owned.alerts.push(alert.id);
    const payment = await db.subscriptionPayment.create({ data: { sellerId, subscriptionId, amount: 1000 + i, status: "PAID", periodStart: new Date(start.getTime() - i * 30 * 86_400_000), periodEnd: new Date(start.getTime() + (1 - i) * 30 * 86_400_000), paidAt: start } });
    owned.payments.push(payment.id);
    owned.refunds.push((await db.subscriptionRefund.create({ data: { sellerId, paymentId: payment.id, amount: 1000 + i, source: "ADMIN", reason: `커서 요청 ${run}-${i}`, createdAt: at } })).id);
  }
});

test.afterAll(async () => {
  if (!db) return;
  try {
    await db.adminAlert.deleteMany({ where: { id: { in: owned.alerts } } });
    await db.platformInquiry.deleteMany({ where: { id: { in: owned.inquiries } } });
    await db.subscriptionRefund.deleteMany({ where: { id: { in: owned.refunds } } });
    await db.subscriptionPayment.deleteMany({ where: { id: { in: owned.payments } } });
    if (subscriptionId) await db.sellerSubscription.deleteMany({ where: { id: subscriptionId } });
    if (ownerId && sellerId) await db.sellerUser.deleteMany({ where: { id: ownerId, sellerId } });
    if (sellerId) await db.seller.deleteMany({ where: { id: sellerId } });
    if (adminId) await db.platformAdmin.deleteMany({ where: { id: adminId } });
  } finally { await db.$disconnect(); }
});

const targets = [
  { key: "alerts", id: "MA-002", route: "/admin/notifications", api: "/api/admin/alerts", query: () => ({ status: "OPEN,IN_PROGRESS", seller: shopName }), row: "notification-row", link: "/admin/support/inquiries/" },
  { key: "refunds", id: "MA-026", route: "/admin/billing/refunds", api: "/api/admin/subscription-refunds", query: () => ({ status: "pending" }), row: "refund-row", link: "/admin/billing/refunds/" },
  { key: "inquiries", id: "MA-051", route: "/admin/support/inquiries", api: "/api/admin/platform-inquiries", query: () => ({ status: "OPEN", sellerId: sellerId!, urgent: "first" }), row: "inquiry-row", link: "/admin/support/inquiries/" },
] as const;

async function capture(page: Page, name: string, state: string) {
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
  const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null, scrollWidth: document.documentElement.scrollWidth }));
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify({ actualGitSha: sha, role: "READ_ONLY", route: page.url(), state, fixture: "current-job-owned-synthetic", browserZoom: "UNVERIFIED", metrics, rows: await page.locator("tbody tr").allTextContents() }, null, 2));
}

for (const target of targets) test(`${target.id}: 서버 10개 현재 페이지와 끝·앞뒤·조건 초기화 및 조회 권한을 보존한다`, async ({ page }) => {
  try {
    await page.goto("/admin/login");
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호").fill(password);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto(`${target.route}${target.key === "inquiries" ? `?sellerId=${sellerId}` : ""}`);
    if (target.key === "alerts") {
      await page.getByLabel("파트너스 검색").fill(shopName);
      await page.getByRole("button", { name: "검색", exact: true }).click();
      await expect(page.getByTestId(target.row).locator("select")).toHaveCount(0);
    }
    const rows = page.getByTestId(target.row);
    const nav = page.getByRole("navigation", { name: "페이지 이동", exact: true });
    const pages: string[][] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams(target.query());
      if (cursor) query.set("cursor", cursor);
      const response = await page.request.get(`${target.api}?${query}`);
      expect(response.status()).toBe(200);
      const body: { items: { id: string }[]; nextCursor: string | null } = await response.json();
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.length).toBeLessThanOrEqual(10);
      if (body.nextCursor) {
        expect(body.items).toHaveLength(10);
        expect(cursors.has(body.nextCursor)).toBe(false);
        cursors.add(body.nextCursor);
      }
      pages.push(body.items.map((r) => r.id));
      cursor = body.nextCursor ?? undefined;
    } while (cursor);
    expect(pages[0]).toEqual(owned[target.key].slice(0, 10));
    expect(pages[1]).toEqual(owned[target.key].slice(10, 20));
    expect(pages.flat().filter((id) => owned[target.key].includes(id))).toEqual(owned[target.key]);
    expect(new Set(pages.flat()).size).toBe(pages.flat().length);
    if (target.key !== "refunds") expect(pages.map((p) => p.length)).toEqual([10, 10, 3]);
    const check = async (n: number) => {
      await expect(rows).toHaveCount(pages[n - 1].length);
      await expect(nav.getByRole("button", { name: `${n}페이지`, exact: true })).toHaveAttribute("aria-current", "page");
      if (target.key === "alerts") {
        await expect.poll(() => rows.locator(".notification-content strong").allTextContents()).toEqual(pages[n - 1].map((id) => `커서 알림 ${run}-${owned.alerts.indexOf(id)}`));
      } else {
        await expect.poll(() => rows.locator(`a[href^="${target.link}"]`).evaluateAll((links) => links.map((a) => a.getAttribute("href")?.split("/").pop()))).toEqual(pages[n - 1]);
      }
    };
    await check(1);
    await expect(nav.getByRole("button", { name: "마지막", exact: true })).toHaveCount(0);
    const requests: string[] = [];
    const listener = (r: import("@playwright/test").Request) => { const u = new URL(r.url()); if (u.pathname === target.api && u.searchParams.has("cursor")) requests.push(r.url()); };
    page.on("request", listener);
    await nav.getByRole("button", { name: "다음", exact: true }).evaluate((button) => { if (button instanceof HTMLButtonElement) { button.click(); button.click(); } });
    await check(2);
    expect(requests).toHaveLength(1);
    page.off("request", listener);
    for (let n = 3; n <= pages.length; n++) { await nav.getByRole("button", { name: "다음", exact: true }).click(); await check(n); }
    await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
    await nav.getByRole("button", { name: "이전", exact: true }).click(); await check(pages.length - 1);
    await nav.getByRole("button", { name: "처음", exact: true }).click(); await check(1);
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await capture(page, `list10-${target.id}-${width}`, "first-page-ready");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await nav.getByRole("button", { name: "다음", exact: true }).click(); await check(2);
    if (target.key === "alerts") {
      await page.getByLabel("유형", { exact: true }).selectOption("INQUIRY_URGENT");
      await page.getByRole("button", { name: "검색", exact: true }).click(); await check(1);
      await page.getByLabel("파트너스 검색").fill(`없는몰-${run}`);
      await page.getByRole("button", { name: "검색", exact: true }).click();
      await expect(rows).toHaveCount(0); await expect(nav).toHaveCount(0);
      await page.getByLabel("파트너스 검색").fill(shopName);
      await page.getByRole("button", { name: "검색", exact: true }).click(); await check(1);
    } else if (target.key === "refunds") {
      await page.getByRole("radio", { name: /^완료/ }).click();
      await expect(rows.filter({ hasText: shopName })).toHaveCount(0);
      await page.getByRole("radio", { name: /^대기 / }).click(); await check(1);
    } else {
      await page.getByRole("radio", { name: "방송 화면", exact: true }).check();
      await page.getByRole("button", { name: "검색", exact: true }).click();
      await expect(rows).toHaveCount(1); await expect(nav).toHaveCount(0);
      await page.getByRole("button", { name: "초기화", exact: true }).click(); await check(1);
    }
  } catch (error) {
    try { await capture(page, `list10-${target.id}-failed`, "failed"); } catch { /* 최초 오류 보존 */ }
    throw error;
  }
});
