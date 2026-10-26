import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// PHASE1 표시 검수만: 실제 TEST/공유 DB 실행을 거부한다. GET 응답은 합성 상태이며 실제 서버 측정값이 아니다.
const run = randomBytes(6).toString("hex");
const email = `phase1-${run}@example.com`;
const password = randomBytes(16).toString("base64url");
const widths = [1126, 390] as const;
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const event: unknown = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : null;
let candidateSha = sha;
if (event && typeof event === "object" && "pull_request" in event) {
  const pr = event.pull_request;
  if (pr && typeof pr === "object" && "head" in pr) {
    const head = pr.head;
    if (head && typeof head === "object" && "sha" in head && typeof head.sha === "string") candidateSha = head.sha;
  }
}
const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const shots = path.join(process.cwd(), "tests/e2e/screenshots");
const diagnostics = path.join(shots, `current-shell-${sha}`);
let db: PrismaClient;
let adminId: string | undefined;
const sellerIds: string[] = [];

test.beforeAll(async ({}, info) => {
  expect(process.env.CI).toBe("true");
  expect(["e2e-smoke", "e2e-full"]).toContain(process.env.GITHUB_JOB);
  expect(process.env.GITHUB_RUN_ID).toMatch(/^\d+$/);
  expect(process.env.NODE_ENV).not.toBe("production");
  expect(info.config.workers).toBe(1); // id=1 사업자 설정의 독점 lease: 현재 job, 단일 worker, 이 spec의 finally만 복원한다.
  expect(execFileSync("git", ["rev-parse", `${candidateSha}^{tree}`], { encoding: "utf8" }).trim()).toBe(tree);
  const url = assertTestDatabaseUrl(process.env.DATABASE_URL);
  expect(new URL(url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(new URL(url).pathname).toBe("/live_obs_test");
  const base = new URL(String(info.project.use.baseURL));
  expect(base.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(base.port).toBe("3100");
  db = new PrismaClient({ datasources: { db: { url } } });
  adminId = (await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "PHASE1 합성 관리자", role: "SUPER_ADMIN" } })).id;
  await mkdir(diagnostics, { recursive: true });
});

test.afterAll(async () => {
  if (!db) return;
  try {
    if (sellerIds.length) {
      await db.shopLegalNotice.deleteMany({ where: { sellerId: { in: sellerIds } } });
      await db.seller.deleteMany({ where: { id: { in: sellerIds } } });
    }
    if (adminId) {
      await db.adminSession.deleteMany({ where: { adminId } });
      await db.platformAdmin.delete({ where: { id: adminId } });
    }
  } finally { await db.$disconnect(); }
});

// 최초 준비/단언 오류를 raw 증거 저장 오류로 덮지 않는다. fixture에는 합성 값만 넣으며 DB snapshot은 기록하지 않는다.
async function capture(page: Page, target: Locator, ids: string[], role: string, state: string, width: number, fixture: unknown, verify: () => Promise<void>) {
  let failed = false;
  let original: unknown;
  try {
    await verify();
    await target.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  } catch (error) { failed = true; original = error; }
  const file = `phase1-${ids.join("-")}-${state}-${width}`;
  try {
    const metrics = await page.evaluate(() => ({
      route: location.pathname, innerWidth, innerHeight, dpr: devicePixelRatio,
      visualViewportScale: visualViewport?.scale ?? null,
      scrollX, scrollY, documentWidth: document.documentElement.scrollWidth,
    }));
    const bounds = await target.evaluateAll((nodes) => nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { text: node.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    }));
    const headerDiagnostics = ids.includes("ADM03") ? {
      dom: await page.locator('section[aria-labelledby="infra-cap"] thead th').evaluateAll((nodes) => nodes.map((node) => ({
        text: node.textContent, role: node.getAttribute("role"), scope: node.getAttribute("scope"),
        ariaLabel: node.getAttribute("aria-label"), ariaHidden: node.getAttribute("aria-hidden"),
        display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility,
      }))),
      ariaSnapshot: await page.locator('section[aria-labelledby="infra-cap"]').ariaSnapshot().catch(() => "UNAVAILABLE"),
    } : null;
    const saved = await Promise.allSettled([
      page.screenshot({ path: path.join(shots, `${file}.png`), fullPage: false }),
      writeFile(path.join(diagnostics, `${file}.json`), JSON.stringify({ actualGitSha: sha, candidateSha, tree, ids, role, state, fixtureSource: "current-job-owned-synthetic", fixture, browserZoom: "UNVERIFIED", failed, metrics, bounds, headerDiagnostics }, null, 2)),
    ]);
    const saveFailure = saved.find((result) => result.status === "rejected");
    if (saveFailure?.status === "rejected") throw saveFailure.reason;
    if (!failed) {
      expect(metrics.innerWidth).toBe(width);
      expect(bounds).toHaveLength(1);
      expect(bounds[0].bottom).toBeGreaterThan(bounds[0].top);
    }
  } catch (error) { if (!failed) throw error; }
  if (failed) throw original;
}

async function adminLogin(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("ADM03·ADM04: 코어 대비 100 초과 부하, 수집 실패 우선, 미측정과 실제 0", async ({ page }) => {
  test.setTimeout(90_000);
  await adminLogin(page);
  const checkedAt = "2026-10-11T00:00:00.000Z";
  const snapshot = (instance: string, pct: number | null, takenAt = checkedAt) => ({
    instance, takenAt,
    disk: { totalBytes: pct === null ? null : 1024 ** 3, usedBytes: pct === null ? null : 0, usedPct: pct },
    memory: { totalBytes: pct === null ? null : 1024 ** 3, usedBytes: pct === null ? null : 0, usedPct: pct },
    cpu: { count: 4, load1: pct === null ? null : 0, usedPct: pct },
    db: { sizeBytes: 0, connections: 0, maxConnections: 100, connectionsPct: 0 },
    backup: { lastAt: checkedAt, count: 1, totalBytes: 0 },
  });
  const high = snapshot("phase1-current", 0);
  high.cpu = { count: 4, load1: 116.98, usedPct: 2924.5 };
  // JSON의 비유한 값은 null이 된다. 실제 응답 null을 검증하며 NaN/Infinity 응답을 만들지 않는다.
  const serializedNonfinite = JSON.stringify({ cpu: Infinity, memory: NaN });
  expect(JSON.parse(serializedNonfinite)).toEqual({ cpu: null, memory: null });
  const cases = [
    { name: "load-over-100", current: high, snapshots: [], signals: [{ key: "cpu", level: "critical", value: 2924.5, threshold: 90 }], banner: "긴급 1", cpu: "2924.5%", rowStatus: "위험" },
    { name: "collection-failed", current: snapshot("phase1-current", null), snapshots: [snapshot("phase1-stale", 0, "2026-10-10T20:00:00.000Z")], signals: [{ key: "cpu", level: "critical", value: 2924.5, threshold: 90 }, { key: "memory", level: "warning", value: 82, threshold: 80 }], banner: "수집 실패 2", cpu: "—", rowStatus: "수집 실패" },
    { name: "measured-zero", current: snapshot("phase1-current", 0), snapshots: [], signals: [], banner: "정상", cpu: "0%", rowStatus: "정상" },
  ];
  let response = { checkedAt, thresholds: { warnPct: 80, criticalPct: 90, backupMaxAgeHours: 36 }, ...cases[0] };
  await page.route("**/api/admin/infra/status", (route) => route.request().method() === "GET" ? route.fulfill({ json: response }) : route.abort());
  await page.route("**/api/admin/infra/cost", (route) => route.request().method() === "GET" ? route.fulfill({ json: { checkedAt, month: "2026-10", prices: {}, priceVersion: 0, items: [], limited: [], totals: { accruedWon: 0, projectedWon: 0 } } }) : route.abort());
  await page.route("**/api/admin/infra/connections", (route) => route.request().method() === "GET" ? route.fulfill({ json: { connections: [] } }) : route.abort());
  for (const state of cases) for (const width of widths) {
    response = { checkedAt, thresholds: { warnPct: 80, criticalPct: 90, backupMaxAgeHours: 36 }, ...state };
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const row = page.getByTestId("infra-server-row").filter({ hasText: "phase1-current" });
    const cpu = row.getByRole("cell").nth(3);
    await capture(page, cpu, ["ADM03", "ADM04"], "SUPER_ADMIN", state.name, width, { response, nonfiniteInput: ["Infinity", "NaN"], nonfiniteWire: serializedNonfinite }, async () => {
      await page.goto("/admin/ops/infra");
      await expect(page.getByTestId("infra-status").locator("b")).toHaveText(state.banner);
      const header = page.locator('section[aria-labelledby="infra-cap"] thead th').filter({ hasText: /^CPU 1분 부하\(코어 대비\)$/ });
      await expect(header).toHaveCount(1);
      await expect(header).toHaveText("CPU 1분 부하(코어 대비)");
      await expect(header).toBeVisible();
      await expect(row).toHaveCount(1);
      await expect(cpu).toHaveText(state.cpu);
      await expect(row.getByRole("cell").nth(4)).toHaveText(state.rowStatus);
      if (state.name === "collection-failed") {
        await expect(page.getByTestId("infra-server-row").filter({ hasText: "phase1-stale" }).getByRole("cell").nth(4)).toHaveText("수집 실패");
        await expect(page.getByTestId("infra-status")).not.toContainText("정상");
      }
    });
  }
});

test("SEL31: 미설정·충전 꺼진 0은 안내, 확정된 0은 실제 0원", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fmessage-balance");
  await submitSellerLogin(page, "demo-owner@example.com", process.env.E2E_PASSWORD || "E2E-demo-1234!");
  await expect(page).toHaveURL(/\/seller\/settings\/message-balance$/);
  const channels = ["MAIL_TRANSACTIONAL", "MAIL_BULK", "SMS", "LMS", "ALIMTALK", "IDENTITY_VERIFICATION", "DELIVERY_TRACKING", "INVOICE_ISSUE", "INVOICE_LABEL", "CASH_RECEIPT", "TAX_INVOICE"];
  const base = { paidBalance: 0, freeBalance: 0, total: 0, lowBalanceThreshold: 0, lowBalance: false, noticeVersion: "phase1-synthetic", consent: null, mail: { month: "2026-10", quota: 1000, sent: 0, freeSent: 0, chargedSent: 0, pending: 0, skippedBalance: 0, skippedPlatformLimit: 0, failed: 0 } };
  const cases = [
    { name: "price-unset", chargingEnabled: false, prices: [], expected: "단가 확정 후 안내" },
    { name: "charging-off-zero", chargingEnabled: false, prices: channels.map((channel) => ({ channel, unitPrice: 0, next: null })), expected: "단가 확정 후 안내" },
    { name: "confirmed-zero", chargingEnabled: true, prices: channels.map((channel) => ({ channel, unitPrice: 0, next: null })), expected: "1통당 0원" },
  ];
  let response = { ...base, ...cases[0] };
  await page.route("**/api/seller/message-balance", (route) => route.request().method() === "GET" ? route.fulfill({ json: response }) : route.abort());
  await page.route("**/api/seller/message-balance/ledger?*", (route) => route.request().method() === "GET" ? route.fulfill({ json: { entries: [], nextCursor: null } }) : route.abort());
  for (const state of cases) for (const width of widths) {
    response = { ...base, ...state };
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const table = page.getByTestId("price-table");
    const row = table.getByRole("row").filter({ hasText: "광고·공지 대량 메일" });
    await capture(page, table, ["SEL31"], "STORE_OWNER", state.name, width, response, async () => {
      await page.goto("/seller/settings/message-balance");
      await expect(row).toHaveCount(1);
      await expect(row.getByRole("cell").nth(2)).toHaveText(state.expected);
      await expect(table).not.toContainText("1통당 [확정 전]원");
      if (!state.chargingEnabled) await expect(table.getByText("단가 확정 후 안내", { exact: true })).toHaveCount(6);
      else await expect(table.getByText("단가 확정 후 안내", { exact: true })).toHaveCount(0);
    });
  }
});

test("SHOP02: 합성 상점의 사업자 양성·빈값과 명시 호스팅 문장", async ({ page }) => {
  test.setTimeout(60_000);
  for (const positive of [true, false]) {
    const state = positive ? "business-present" : "business-empty";
    const slug = `phase1-${run}-${positive ? "present" : "empty"}`;
    const businessInfo = positive ? { companyName: "합성 상호", representativeName: "합성 대표", businessNumber: "1234567890", mailOrderNumber: "합성 신고번호" } : {};
    const seller = await db.seller.create({ data: { slug, shopName: "PHASE1 합성 상점", status: "ACTIVE", businessInfo } });
    sellerIds.push(seller.id);
    await db.shopLegalNotice.create({ data: { sellerId: seller.id, address: positive ? "합성 주소" : "", csPhone: positive ? "합성 연락처" : "" } });
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const footer = page.locator(".shop-foot");
      await capture(page, footer, ["SHOP02"], "PUBLIC_BUYER", state, width, { businessInfo, address: positive ? "합성 주소" : "", csPhone: positive ? "합성 연락처" : "" }, async () => {
        await page.goto(`/shop/${slug}/terms`);
        await expect(footer.locator(".shop-foot-by")).toHaveText("ONQ로 운영하는 쇼핑몰이에요");
        await expect(footer.getByText("호스팅 제공", { exact: true })).toHaveCount(1);
        await expect(footer.getByText("ONQ", { exact: true })).toHaveCount(1);
        for (const label of ["상호", "대표자", "사업자등록번호", "통신판매업 신고", "주소", "고객센터"]) {
          await expect(footer.locator("dt").filter({ hasText: new RegExp(`^${label}$`) })).toHaveCount(positive ? 1 : 0);
        }
        if (positive) for (const value of ["합성 상호", "합성 대표", "123-45-67890", "합성 신고번호", "합성 주소", "합성 연락처"]) await expect(footer.getByText(value, { exact: true })).toHaveCount(1);
      });
    }
  }
});

test("WEB01: 소개 바닥글은 기존 6개 사업자 값만 표시하고 빈행을 숨긴다", async ({ page }) => {
  test.setTimeout(60_000);
  // beforeAll이 현재 e2e-smoke job의 loopback live_obs_test / worker=1을 확인한 뒤에만 접근한다.
  const original = await db.platformBusinessInfo.findUnique({ where: { id: 1 } });
  const present = { name: "합성 플랫폼", representative: "합성 대표", businessNumber: "합성 사업자번호", mailOrderNumber: "합성 신고번호", address: "합성 플랫폼 주소", phone: "합성 고객센터" };
  const empty = { name: "", representative: "", businessNumber: "", mailOrderNumber: "", address: "", phone: "" };
  try {
    for (const positive of [true, false]) {
      const fixture = positive ? present : empty;
      await db.platformBusinessInfo.upsert({ where: { id: 1 }, create: { id: 1, ...fixture }, update: fixture });
      for (const width of widths) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const footer = page.locator("footer");
        await capture(page, footer, ["WEB01"], "PUBLIC", positive ? "business-present" : "business-empty", width, fixture, async () => {
          await page.goto("/about");
          await expect(footer).toHaveCount(1);
          if (positive) await expect(footer.locator("p").filter({ hasText: "상호 합성 플랫폼" })).toHaveText("상호 합성 플랫폼 · 대표 합성 대표 · 사업자등록번호 합성 사업자번호 · 통신판매업 신고 합성 신고번호 · 주소 합성 플랫폼 주소 · 고객센터 합성 고객센터");
          else for (const label of ["상호", "사업자등록번호", "통신판매업 신고", "고객센터"]) await expect(footer).not.toContainText(label);
        });
      }
    }
  } finally {
    // 원 행 전체(수정 시각/수정자 포함)를 복원한다. 원 값은 로그/캡처/fixture metadata로 내보내지 않는다.
    if (original) await db.platformBusinessInfo.upsert({ where: { id: 1 }, create: original, update: original });
    else await db.platformBusinessInfo.deleteMany({ where: { id: 1 } });
  }
});
