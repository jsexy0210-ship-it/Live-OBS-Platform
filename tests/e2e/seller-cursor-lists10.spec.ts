import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { formatDateTime } from "../../lib/client/format";
import { submitSellerLogin } from "./sellerLogin";

// 기존 CI job의 고유 폐기 테넌트에서 조회만 검증한다. 발송·답변·환불·적립·설정 변경은 실행하지 않는다.
const run = randomBytes(6).toString("hex");
const email = `cursor-${run}-owner@example.com`;
const password = randomBytes(12).toString("base64url");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = `tests/e2e/screenshots/current-shell-${sha}`;
let db: PrismaClient;
let sellerId: string | undefined;

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
  const now = new Date();
  sellerId = (await db.seller.create({ data: { slug: `cursor-eight-${run}`, shopName: `커서 조회 ${run}`, status: "ACTIVE", approvedAt: now, trialEndsAt: new Date(now.getTime() + 7 * 86_400_000) } })).id;
  const owner = await db.sellerUser.create({ data: { sellerId, email, passwordHash: await hashPassword(password), name: "목록 조회", isOwner: true } });
  const grade = await db.memberGrade.create({ data: { sellerId, displayName: "일반", sortOrder: 0, systemKey: "BASIC" } });
  const product = await db.product.create({ data: { sellerId, name: `커서 상품 ${run}`, price: 1000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId, productId: product.id, name: "기본", stock: 100 } });
  // 월 경계에도 기본 기간 안에 23행이 모두 남도록 현재 KST 날짜의 정오를 기준으로 한다.
  const day = new Date(now.getTime() + 9 * 3_600_000);
  const anchor = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 3);
  for (let i = 0; i < 23; i++) {
    const at = new Date(anchor - i * 60_000);
    const nickname = `커서 회원 ${run}-${i}`;
    const buyer = await db.buyerMember.create({ data: { sellerId, gradeId: grade.id, loginId: `cursor-${run}-${i}`, passwordHash: "unused", name: nickname, phone: `synthetic-${run}-${i}`, ciHash: `cursor-${run}-${i}`, identityVerifiedAt: now, broadcastNickname: nickname } });
    const order = await db.order.create({ data: { sellerId, buyerMemberId: buyer.id, orderNo: 700 + i, broadcastNicknameSnapshot: nickname, totalAmount: 1000, status: "PAID", paidAt: at, createdAt: at } });
    await db.orderShippingAddress.create({ data: { sellerId, orderId: order.id, recipientName: nickname, phone: `synthetic-${run}`, zipCode: "synthetic", address1: "합성 조회 주소" } });
    const item = await db.orderItem.create({ data: { sellerId, orderId: order.id, productId: product.id, optionId: option.id, productNameSnapshot: product.name, optionNameSnapshot: option.name, unitPrice: 1000, quantity: 1 } });
    const request = await db.returnRequest.create({ data: { sellerId, orderId: order.id, buyerMemberId: buyer.id, kind: "RETURN", reason: "OTHER", status: i === 22 ? "COMPLETED" : "REQUESTED", createdAt: at } });
    await db.returnRequestItem.create({ data: { sellerId, returnRequestId: request.id, orderItemId: item.id, quantity: 1 } });
    await db.productReview.create({ data: { sellerId, orderId: order.id, orderItemId: item.id, productId: product.id, buyerMemberId: buyer.id, authorNickname: nickname, rating: i === 22 ? 1 : 5, body: `커서 리뷰 ${run}-${i}`, status: "VISIBLE", createdAt: at } });
    await db.buyerInquiry.create({ data: { sellerId, buyerMemberId: buyer.id, kind: "GENERAL", authorNickname: nickname, title: `커서 문의 ${run}-${i}`, body: "합성 조회 내용", status: i === 22 ? "ANSWERED" : "WAITING", createdAt: at } });
    await db.rewardLedger.create({ data: { sellerId, buyerMemberId: buyer.id, type: "ADJUST", amount: 100 + i, status: "SUCCEEDED", testMode: false, idempotencyKey: `cursor-${run}-${i}`, createdAt: at, processedAt: at } });
    await db.rewardBalance.create({ data: { sellerId, buyerMemberId: buyer.id, balance: 100 + i, updatedAt: at } });
    await db.memberMessage.create({ data: { sellerId, title: `커서 발송 ${run}-${i}`, kind: "INFO", channel: "MAIL", body: "합성 기록", renderedBody: "합성 기록", targetType: "ALL", status: "RECORDED", estimatedCount: 0, createdAt: at, recordedAt: at } });
    await db.auditLog.create({ data: { sellerId, actorType: "SELLER_USER", actorId: owner.id, action: "reward_policy.live_payout", after: { enabled: i % 2 === 0 }, createdAt: at } });
  }
});

test.afterAll(async () => {
  if (!db) return;
  try {
    if (sellerId) {
      const where = { sellerId };
      await db.auditLog.deleteMany({ where });
      await db.memberMessage.deleteMany({ where });
      await db.buyerInquiry.deleteMany({ where });
      await db.productReview.deleteMany({ where });
      await db.returnRequestItem.deleteMany({ where });
      await db.returnRequest.deleteMany({ where });
      await db.rewardLedger.deleteMany({ where });
      await db.rewardBalance.deleteMany({ where });
      await db.orderShippingAddress.deleteMany({ where });
      await db.orderItem.deleteMany({ where });
      await db.order.deleteMany({ where });
      await db.buyerMember.deleteMany({ where });
      await db.memberGrade.deleteMany({ where });
      await db.productOption.deleteMany({ where });
      await db.product.deleteMany({ where });
      await db.seller.deleteMany({ where: { id: sellerId } });
    }
  } finally { await db.$disconnect(); }
});

type Row = { id?: string; orderId?: string; orderNo?: number; member?: { id: string; broadcastNickname: string | null }; amount?: number; title?: string; body?: string; at?: string };
type Data = { shipments?: Row[]; returns?: Row[]; entries?: Row[]; balances?: Row[]; history?: Row[]; inquiries?: Row[]; reviews?: Row[]; messages?: Row[]; nextCursor: string | null };
const targets = [
  { id: "SA-025", route: "/seller/shipping", api: "/api/seller/shipments", field: "shipments", rows: '[data-testid="shipment-row"]', query: { tab: "ready" }, text: (r: Row) => String(r.orderNo) },
  { id: "SA-029", route: "/seller/returns", api: "/api/seller/returns", field: "returns", rows: '[data-testid="return-row"]', query: {}, text: (r: Row) => String(r.orderNo) },
  { id: "SA-032", route: "/seller/rewards/ledger?period=all", api: "/api/seller/reward-ledger", field: "entries", rows: '[data-testid="ledger-row"]', query: {}, text: (r: Row) => `${r.amount}원` },
  { id: "SA-033", route: "/seller/rewards/balances", api: "/api/seller/reward-balances", field: "balances", rows: '[data-testid="balance-row"]', query: {}, text: (r: Row) => r.member?.broadcastNickname ?? "" },
  { id: "SA-034", route: "/seller/rewards/live-payout", api: "/api/seller/reward-live-payout/history", field: "history", rows: '[data-testid="live-history"] tbody tr', query: {}, text: (r: Row) => formatDateTime(r.at ?? "") },
  { id: "SA-046", route: "/seller/buyer-inquiries?period=all", api: "/api/seller/inquiries", field: "inquiries", rows: '[data-testid="inquiry-row"]', query: {}, text: (r: Row) => r.title ?? "" },
  { id: "SA-048", route: "/seller/reviews", api: "/api/seller/reviews", field: "reviews", rows: '[data-testid="review-row"]', query: {}, text: (r: Row) => r.body ?? "" },
  { id: "SA-049", route: "/seller/member-messages", api: "/api/seller/member-messages", field: "messages", rows: '[data-testid="mm-item"]', query: {}, text: (r: Row) => r.title ?? "" },
] as const;

async function capture(page: Page, id: string, width: number, state: string) {
  const metrics = await page.evaluate(() => ({ route: location.pathname + location.search, innerWidth, innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null, scrollWidth: document.documentElement.scrollWidth, rows: [...document.querySelectorAll('main [data-testid$="-row"], main [data-testid="mm-item"], [data-testid="live-history"] tbody tr')].map((el) => ({ text: el.textContent, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })) }));
  writeFileSync(`${evidence}/seller-cursor-${id}-${width}-${state}.json`, JSON.stringify({ sha, role: "OWNED_STORE_OWNER", state, browserZoom: "UNVERIFIED", ...metrics }, null, 2));
  await page.screenshot({ path: `tests/e2e/screenshots/seller-cursor-${id}-${width}-${state}.png`, fullPage: true });
  expect(metrics.innerWidth).toBe(width);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
}

for (const target of targets) test(`${target.id}: 조회 목록 10개와 커서 끝·이전·처음·중복 요청을 보존한다`, async ({ page }) => {
  test.setTimeout(90_000);
  let width = 1440;
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/seller/login?next=${encodeURIComponent(target.route)}`);
    await submitSellerLogin(page, email, password);
    await expect(page).toHaveURL(new RegExp(target.route.split("?")[0].replaceAll("/", "\\/") + "(?:\\?|$)"));
    const fetchPage = async (cursor?: string) => {
      const p = new URLSearchParams(target.query);
      if (cursor) p.set("cursor", cursor);
      const response = await page.request.get(`${target.api}?${p}`);
      expect(response.status()).toBe(200);
      const data: Data = await response.json();
      const rows = data[target.field];
      expect(rows).toBeDefined();
      return { rows: rows ?? [], next: data.nextCursor };
    };
    const first = await fetchPage(); const second = await fetchPage(first.next ?? undefined); const last = await fetchPage(second.next ?? undefined);
    expect(first.rows).toHaveLength(10); expect(first.next).not.toBeNull();
    expect(second.rows).toHaveLength(10); expect(second.next).not.toBeNull();
    expect(last.rows).toHaveLength(3); expect(last.next).toBeNull();
    const ids = [...first.rows, ...second.rows, ...last.rows].map((r) => r.id ?? r.orderId ?? r.member?.id);
    expect(ids).not.toContain(undefined); expect(new Set(ids).size).toBe(23);
    const nav = page.getByRole("navigation", { name: "페이지 이동", exact: true });
    const check = async (rows: Row[], n: number) => {
      const rendered = page.locator(target.rows);
      await expect(rendered).toHaveCount(rows.length);
      await expect(nav.getByRole("button", { name: `${n}페이지`, exact: true })).toHaveAttribute("aria-current", "page");
      for (let i = 0; i < rows.length; i++) {
        expect(target.text(rows[i])).not.toBe("");
        await expect(rendered.nth(i)).toContainText(target.text(rows[i]));
      }
    };
    await check(first.rows, 1);
    await expect(nav.getByRole("button", { name: "마지막", exact: true })).toHaveCount(0);
    for (const size of [1440, 1024]) { width = size; await page.setViewportSize({ width, height: 900 }); await capture(page, target.id, width, "first"); }
    const requests: string[] = [];
    const listener = (request: import("@playwright/test").Request) => { const url = new URL(request.url()); if (url.pathname === target.api && url.searchParams.has("cursor")) requests.push(request.url()); };
    page.on("request", listener);
    await nav.getByRole("button", { name: "다음", exact: true }).evaluate((button) => { if (button instanceof HTMLButtonElement) { button.click(); button.click(); } });
    await check(second.rows, 2); expect(requests).toHaveLength(1); page.off("request", listener);
    await nav.getByRole("button", { name: "다음", exact: true }).click(); await check(last.rows, 3);
    await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
    await nav.getByRole("button", { name: "이전", exact: true }).click(); await check(second.rows, 2);
    await nav.getByRole("button", { name: "처음", exact: true }).click(); await check(first.rows, 1);
    if (["SA-025", "SA-032", "SA-033", "SA-046"].includes(target.id)) {
      await nav.getByRole("button", { name: "다음", exact: true }).click(); await check(second.rows, 2);
      const search = target.id === "SA-025" ? page.getByRole("searchbox") : page.getByLabel("검색어", { exact: true });
      await expect(search).toHaveCount(1); await search.fill(`일치하지않는-${run}`);
      if (target.id !== "SA-025") await page.getByRole("button", { name: "검색", exact: true }).click();
      await expect(page.locator(target.rows)).toHaveCount(0); await expect(nav).toHaveCount(0);
      if (target.id === "SA-025") await search.fill("");
      else await page.getByRole("button", { name: "초기화", exact: true }).click();
      await check(first.rows, 1);
    }
    if (target.id === "SA-029") { await page.getByRole("tab", { name: "완료 · 거절", exact: true }).click(); await expect(page.locator(target.rows)).toHaveCount(1); await expect(nav).toHaveCount(0); }
    if (target.id === "SA-048") { await page.getByRole("combobox", { name: "별점", exact: true }).selectOption("low"); await expect(page.locator(target.rows)).toHaveCount(1); await expect(nav).toHaveCount(0); }
  } catch (error) { try { await capture(page, target.id, width, "failed"); } catch {} throw error; }
});
