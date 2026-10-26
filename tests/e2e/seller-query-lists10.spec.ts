import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// 기존 CI job의 폐기 DB만 사용한다. 외부 발행·환불·입금 확인은 실행하지 않는다.
const run = randomBytes(6).toString("hex");
const email = `query-${run}-owner@example.com`;
const password = randomBytes(12).toString("base64url");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = `tests/e2e/screenshots/current-shell-${sha}`;
let db: PrismaClient;
let sellerId: string | undefined;
let userId: string | undefined;
const owned = { products: [] as string[], members: [] as string[], hits: [] as string[], deposits: [] as string[], refunds: [] as string[], receipts: [] as string[] };

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
  db = new PrismaClient({ datasources: { db: { url } } });
  mkdirSync(evidence, { recursive: true });
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
  sellerId = (await db.seller.create({ data: { slug: `query-${run}`, shopName: `합성 목록 ${run}`, status: "ACTIVE", approvedAt: new Date(), planId: plan.id, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } })).id;
  userId = (await db.sellerUser.create({ data: { sellerId, email, passwordHash: await hashPassword(password), name: "합성 대표", isOwner: true } })).id;
  await db.sellerSubscription.create({ data: { sellerId, planId: plan.id, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
  const grade = await db.memberGrade.create({ data: { sellerId, displayName: "합성 등급", sortOrder: 0 } });
  const now = new Date();
  for (let i = 0; i < 23; i++) {
    const at = new Date(now.getTime() - i * 1000);
    const member = await db.buyerMember.create({ data: { sellerId, gradeId: grade.id, loginId: `query-${run}-${i}`, passwordHash: "unused-synthetic", name: "합성 회원", phone: `0000000${String(i).padStart(4, "0")}`, ciHash: `synthetic-${run}-${i}`, identityVerifiedAt: at, broadcastNickname: `합성 회원 ${i}`, createdAt: at, ...(i === 22 ? { status: "DORMANT" } : {}) } });
    owned.members.push(member.id);
    owned.products.push((await db.product.create({ data: { sellerId, name: `합성 상품 ${i}`, price: 1000 + i, status: i === 22 ? "HIDDEN" : "ON_SALE", createdAt: at } })).id);
    owned.hits.push((await db.hitCard.create({ data: { sellerId, cardName: `합성 카드 ${i}`, nicknameSnapshot: `합성 회원 ${i}`, grade: i === 22 ? "UR" : "SR", createdAt: at } })).id);
    const pending = await db.order.create({ data: { sellerId, buyerMemberId: member.id, orderNo: i + 1, broadcastNicknameSnapshot: `합성 입금 ${i}`, totalAmount: 1000 + i, paymentMethod: "BANK_TRANSFER", paymentDueAt: new Date(now.getTime() + 86_400_000), createdAt: at } });
    owned.deposits.push(pending.id);
    const paid = await db.order.create({ data: { sellerId, buyerMemberId: member.id, orderNo: i + 101, broadcastNicknameSnapshot: `합성 주문 ${i}`, totalAmount: 1000 + i, status: "PAID", paymentMethod: "BANK_TRANSFER", paidAt: at, createdAt: at } });
    owned.refunds.push((await db.refundRequest.create({ data: { sellerId, orderId: paid.id, buyerMemberId: member.id, reason: "CHANGE_OF_MIND", reasonText: `합성 사유 ${i}`, createdAt: at, ...(i === 22 ? { status: "REJECTED", rejectReason: "합성 거절" } : {}) } })).id);
    const receipt = await db.orderReceiptRequest.create({ data: { sellerId, orderId: paid.id, buyerMemberId: member.id, kind: "CASH_RECEIPT_INCOME", identitySealed: "unused-synthetic", identityLast4: "0000", createdAt: at } });
    owned.receipts.push(receipt.id);
    await db.receiptIssue.create({ data: { sellerId, requestId: receipt.id, amount: 1000 + i, status: i === 22 ? "FAILED" : "PENDING", createdAt: at } });
  }
});

test.afterAll(async () => {
  if (!db) return;
  try {
    if (sellerId) {
      // 이 시험 소유 tenant 외에는 삭제하지 않는다. 세션 FK는 사용자 삭제보다 먼저 정리한다.
      await db.receiptIssue.deleteMany({ where: { sellerId } });
      await db.orderReceiptRequest.deleteMany({ where: { sellerId } });
      await db.refundRequest.deleteMany({ where: { sellerId } });
      await db.hitCard.deleteMany({ where: { sellerId } });
      await db.order.deleteMany({ where: { sellerId } });
      await db.product.deleteMany({ where: { sellerId } });
      await db.productCodeCounter.deleteMany({ where: { sellerId } });
      await db.buyerMember.deleteMany({ where: { sellerId } });
      await db.memberGrade.deleteMany({ where: { sellerId } });
      await db.sellerSession.deleteMany({ where: { sellerId } });
      await db.auditLog.deleteMany({ where: { sellerId } });
      await db.sellerSubscription.deleteMany({ where: { sellerId } });
      await db.sellerUser.deleteMany({ where: { sellerId } });
      await db.seller.deleteMany({ where: { id: sellerId } });
    }
  } finally { await db.$disconnect(); }
});


const targets = [
  { key: "products", id: "SA-011", route: "/seller/products", api: "/api/seller/products", row: "product-row", field: "products", selector: "td:nth-child(3) a", label: (i: number) => `합성 상품 ${i}`, filter: "?status=HIDDEN", filteredIndex: 22 },
  { key: "members", id: "SA-041", route: "/seller/members", api: "/api/seller/members", row: "member-row", field: "members", selector: "td:first-child a", label: (i: number) => `합성 회원 ${i}`, filter: "?status=DORMANT", filteredIndex: 22 },
  { key: "hits", id: "SA-053", route: "/seller/hit-cards", api: "/api/seller/hit-cards", row: "hit-list", field: "items", selector: "td:first-child", label: (i: number) => `합성 카드 ${i}`, filter: "?grade=UR", filteredIndex: 22 },
  { key: "deposits", id: "SA-026", route: "/seller/orders/deposits", api: "/api/seller/payments/deposits", row: "deposit-row", field: "deposits", selector: "td:nth-child(3)", label: (i: number) => `합성 입금 ${i}`, filter: "", filteredIndex: 22 },
  { key: "refunds", id: "SA-023", route: "/seller/orders/refund-requests", api: "/api/seller/refund-requests", row: "refund-request-row", field: "requests", selector: "td:nth-child(3)", label: (i: number) => `합성 주문 ${i}`, filter: "?status=REJECTED", filteredIndex: 22 },
  { key: "receipts", id: "SA-024", route: "/seller/orders/receipts", api: "/api/seller/receipt-requests", row: "receipt-row", field: "requests", selector: "td:nth-child(3)", label: (i: number) => `합성 주문 ${i}`, filter: "?status=FAILED", filteredIndex: 22 },
] as const;

async function capture(page: Page, id: string, state: string) {
  const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null, scrollWidth: document.documentElement.scrollWidth }));
  const name = `${id}-query10-${metrics.width}-${state}`;
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify({ actualGitSha: sha, role: "owned-owner", fixture: "current-job-owned-synthetic", route: page.url(), state, browserZoom: "UNVERIFIED", metrics }, null, 2));
}

for (const t of targets) test(`${t.id}: 실제 목록 10개·끝·앞뒤·필터 초기화·중복 요청을 확인한다`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/seller/login");
  await submitSellerLogin(page, email, password);
  await expect(page).toHaveURL(/\/seller$/);
  await page.goto(t.route);
  const rows = t.key === "hits" ? page.getByTestId(t.row).locator("tr") : page.getByTestId(t.row);
  const nav = page.getByRole("navigation", { name: "페이지 이동", exact: true });
  let release: () => void = () => {};
  try {
    const ids: string[][] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams(t.key === "refunds" ? { status: "REQUESTED" } : {});
      if (t.key === "deposits") q.set("offset", String(ids.flat().length));
      if (cursor && t.key !== "deposits") q.set("cursor", cursor);
      const response = await page.request.get(`${t.api}?${q}`);
      expect(response.status()).toBe(200);
      const body = await response.json();
      const items: { id?: string; orderId?: string }[] = body[t.field];
      expect(items.length).toBeLessThanOrEqual(10);
      ids.push(items.map(r => (r.id ?? r.orderId)!));
      cursor = body.nextCursor ?? undefined;
      if (t.key === "deposits" && ids.flat().length < body.total) cursor = "offset";
    } while (cursor);
    if (t.key === "products" || t.key === "members" || t.key === "deposits") {
      const explicit = await page.request.get(`${t.api}?limit=50`);
      expect(explicit.status()).toBe(200); expect((await explicit.json())[t.field]).toHaveLength(23);
    }
    const expected = t.key === "refunds" ? owned[t.key].slice(0, 22).reverse() : t.key === "deposits" ? [...owned[t.key]].reverse() : owned[t.key];
    expect(ids.flat()).toEqual(expected);
    expect(new Set(ids.flat()).size).toBe(ids.flat().length);
    expect(ids.map(x => x.length)).toEqual(t.key === "refunds" ? [10, 10, 2] : [10, 10, 3]);
    const check = async (n: number) => {
      await expect(rows).toHaveCount(ids[n - 1].length);
      await expect(nav.getByRole("button", { name: `${n}페이지`, exact: true })).toHaveAttribute("aria-current", "page");
      const labels = ids[n - 1].map(id => t.label(owned[t.key].indexOf(id)));
      for (let i = 0; i < labels.length; i++) await expect(rows.nth(i)).toContainText(labels[i]);
    };
    await check(1);
    if (t.key !== "deposits") await expect(nav.getByRole("button", { name: "마지막", exact: true })).toHaveCount(0);
    let requests = 0;
    const listener = (r: import("@playwright/test").Request) => { if (new URL(r.url()).pathname === t.api) requests++; };
    page.on("request", listener);
    await nav.getByRole("button", { name: "다음", exact: true }).evaluate(button => { if (button instanceof HTMLButtonElement) { button.click(); button.click(); } });
    await check(2); expect(requests).toBe(1); page.off("request", listener);
    await nav.getByRole("button", { name: "다음", exact: true }).click(); await check(3);
    await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
    await nav.getByRole("button", { name: "이전", exact: true }).click(); await check(2);
    for (const width of [1440, 1024, 390]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await capture(page, t.id, "page2"); }
    await page.setViewportSize({ width: 1440, height: 900 });
    await nav.getByRole("button", { name: "처음", exact: true }).click(); await check(1);
    if (t.key === "products") {
      await expect(page.getByLabel("목록 개수")).toHaveValue("10");
      await expect(page.getByLabel("목록 개수").locator("option")).toHaveText(["10개씩"]);
    }
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    await page.route(`**${t.api}?*`, async route => {
      const q = new URL(route.request().url()).searchParams;
      if (q.has("cursor") || Number(q.get("offset")) > 0) {
        const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
      } else await route.continue();
    });
    await nav.getByRole("button", { name: "다음", exact: true }).click(); await requested;
    if (t.key === "deposits") {
      await page.getByLabel("검색어", { exact: true }).fill(t.label(22));
      await page.getByRole("button", { name: "검색", exact: true }).click();
    } else if (t.key === "products") {
      await page.getByRole("radiogroup", { name: "판매 상태", exact: true }).getByRole("radio", { name: "숨김", exact: true }).check();
      await page.getByRole("button", { name: "검색", exact: true }).click();
    } else if (t.key === "members") await page.getByRole("button", { name: "휴면", exact: true }).click();
    else if (t.key === "hits") {
      await page.getByRole("combobox", { name: "등급", exact: true }).fill("UR");
      await page.getByRole("button", { name: "검색", exact: true }).click();
    } else if (t.key === "receipts") {
      // SA-024는 상태를 검색 패널의 라디오로 고르고 「검색」을 눌러 건다
      await page.getByRole("radio", { name: "실패", exact: true }).check();
      await page.getByRole("button", { name: "검색", exact: true }).click();
    } else await page.getByRole("tab", { name: t.key === "refunds" ? /^거절/ : /^실패/ }).click();
    await expect(rows).toHaveCount(1); await expect(rows.first()).toContainText(t.label(t.filteredIndex));
    await expect(nav).toHaveCount(0);
    const stale = page.waitForResponse(r => new URL(r.url()).pathname === t.api && (new URL(r.url()).searchParams.has("cursor") || Number(new URL(r.url()).searchParams.get("offset")) > 0));
    release(); await stale;
    await expect(rows).toHaveCount(1); await expect(rows.first()).toContainText(t.label(t.filteredIndex)); await expect(nav).toHaveCount(0);
    await page.unroute(`**${t.api}?*`);
    await page.goto(t.route); await check(1);
  } catch (error) { release(); try { await capture(page, t.id, "failed"); } catch {} throw error; }
});

test("SA-023: 처리한 행만 거두고 현재 쪽·스크롤을 보존하며 빈 끝 쪽을 보정한다", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/seller/login"); await submitSellerLogin(page, email, password);
  await expect(page).toHaveURL(/\/seller$/);
  const api = "/api/seller/refund-requests";
  const original: { id: string; [key: string]: unknown }[] = [];
  let cursor: string | null = null;
  do {
    const response = await page.request.get(`${api}?status=REQUESTED${cursor ? `&cursor=${cursor}` : ""}`);
    expect(response.status()).toBe(200);
    const body = await response.json(); original.push(...body.requests); cursor = body.nextCursor;
  } while (cursor);
  expect(original.map(r => r.id)).toEqual(owned.refunds.slice(0, 22).reverse());
  const removed = new Set<string>();
  let failPrevious = false;
  // 화면 처리 응답만 합성한다. 실제 환불·거절 POST를 서버에 보내지 않는다.
  await page.route(`**${api}?*`, route => {
    expect(route.request().method()).toBe("GET");
    const q = new URL(route.request().url()).searchParams;
    const after = q.get("cursor") ? original.findIndex(r => r.id === q.get("cursor")) : -1;
    if (failPrevious && after === 9) { failPrevious = false; return route.fulfill({ status: 503, json: { error: "synthetic_previous_failed" } }); }
    const remaining = original.slice(after + 1).filter(r => !removed.has(r.id));
    const requests = remaining.slice(0, 10);
    return route.fulfill({ json: { requests, nextCursor: remaining.length > 10 ? requests.at(-1)!.id : null, counts: { REQUESTED: original.length - removed.size, REJECTED: 1 + removed.size } } });
  });
  await page.route(`**${api}/*/reject`, route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ reason: "합성 쪽 보존" });
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    expect(owned.refunds).toContain(id); removed.add(id);
    return route.fulfill({ json: { ok: true } });
  });
  const rows = page.getByTestId("refund-request-row");
  const nav = page.getByRole("navigation", { name: "페이지 이동", exact: true });
  const current = (n: number) => expect(nav.getByRole("button", { name: `${n}페이지`, exact: true })).toHaveAttribute("aria-current", "page");
  const scrollMetrics = () => page.evaluate(() => ({ scrollY, scrollHeight: document.documentElement.scrollHeight, innerHeight, maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight) }));
  const rejectFirst = async (keepMiddle = false) => {
    if (keepMiddle) await page.evaluate(() => window.scrollTo(0, Math.floor(Math.max(0, document.documentElement.scrollHeight - innerHeight) / 2)));
    const scroll = await scrollMetrics();
    const link = rows.first().getByRole("link", { name: "처리", exact: true });
    const href = new URL(await link.getAttribute("href") ?? "", page.url());
    expect(href.pathname).toMatch(/^\/seller\/orders\/refund-requests\/[0-9a-f-]{36}$/);
    expect(owned.refunds).toContain(href.pathname.split("/").at(-1));
    expect(href.searchParams.get("returnTo")).toBe("/seller/orders/refund-requests");
    await link.click();
    await expect(page).toHaveURL(href.href);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("onq:refund-requests:return") ?? "null")?.scrollY)).toBe(scroll.scrollY);
    const dialog = page.getByRole("region", { name: /환불 요청 처리/ });
    await dialog.getByRole("button", { name: "거절", exact: true }).click();
    await dialog.getByLabel("거절 사유", { exact: true }).fill("합성 쪽 보존");
    // 한 행 제거 뒤에도 가능한 중간 위치를 고른다. 끝 위치의 브라우저 자동 clamp를 보존 실패와 섞지 않는다.
    await dialog.getByRole("button", { name: "거절 처리", exact: true }).click();
    await expect(page.getByText("환불 요청을 거절했습니다", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "목록으로", exact: true }).click();
    await expect(page).toHaveURL(/\/seller\/orders\/refund-requests$/);
    await expect(dialog).toHaveCount(0);
    return scroll;
  };
  for (const previousFails of [false, true]) {
    removed.clear();
    await page.goto("/seller/orders/refund-requests");
    await nav.getByRole("button", { name: "다음", exact: true }).click(); await current(2);
    const before = await rows.allTextContents();
    const scroll = await rejectFirst(true);
    await current(2); await expect(rows).toHaveCount(9);
    await expect(rows).toHaveText(before.slice(1));
    await expect.poll(async () => (await scrollMetrics()).scrollY).toBe(scroll.scrollY);
    const afterScroll = await scrollMetrics();
    writeFileSync(`${evidence}/SA-023-scroll-${previousFails ? "previous-error" : "previous-ok"}.json`, JSON.stringify({ actualGitSha: sha, route: "/seller/orders/refund-requests", state: "page2-row-removed", before: scroll, after: afterScroll }, null, 2));
    expect(scroll.scrollY).toBeGreaterThan(0);
    expect(scroll.scrollY).toBeLessThan(afterScroll.maxScroll);
    expect(afterScroll.scrollY).toBe(scroll.scrollY);
    await expect(page.getByTestId("refund-summary")).toContainText("21건");
    await nav.getByRole("button", { name: "다음", exact: true }).click(); await current(3); await expect(rows).toHaveCount(2);
    await rejectFirst(); await current(3); await expect(rows).toHaveCount(1);
    failPrevious = previousFails;
    await rejectFirst();
    if (previousFails) {
      await current(3); await expect(rows).toHaveCount(0);
      await expect(page.getByText("불러오지 못했습니다. 다시 눌러 주십시오", { exact: true })).toBeVisible();
      await nav.getByRole("button", { name: "이전", exact: true }).click();
    }
    await current(2); await expect(rows).toHaveCount(9);
    await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
    await expect(page.getByTestId("refund-summary")).toContainText("19건");
  }
});

test("SA-024: 미결제 후속 처리와 영수증 권한을 보존한다", async ({ page }) => {
  await db.seller.update({ where: { id: sellerId! }, data: { trialEndsAt: new Date(Date.now() - 86_400_000) } });
  await db.sellerSubscription.update({ where: { sellerId }, data: { currentPeriodEnd: new Date(Date.now() - 86_400_000), status: "CANCELED" } });
  const receiptEmail = `query-${run}-receipt@example.com`;
  const deniedEmail = `query-${run}-denied@example.com`;
  for (const [staffEmail, permissions] of [[receiptEmail, ["RECEIPT_TAX"]], [deniedEmail, []]] as const) {
    await db.sellerUser.create({ data: { sellerId: sellerId!, email: staffEmail, passwordHash: await hashPassword(password), name: "합성 직원", permissions: [...permissions] } });
  }
  for (const [staffEmail, status] of [[receiptEmail, 200], [deniedEmail, 403]] as const) {
    await page.context().clearCookies();
    await page.goto("/seller/login?next=%2Fseller%2Forders%2Freceipts");
    await submitSellerLogin(page, staffEmail, password);
    await expect(page).toHaveURL(/\/seller\/orders\/receipts$/);
    const response = await page.request.get("/api/seller/receipt-requests");
    expect(response.status()).toBe(status);
    if (status === 200) {
      const body = await response.json();
      expect(body.requests).toHaveLength(10);
      expect(body.counts).toEqual({ PENDING: 22, FAILED: 1 });
    }
  }
});
