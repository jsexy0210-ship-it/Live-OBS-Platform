import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// 목록은 고유 합성 응답만 쓴다. 로그인은 CI가 만든 유효 체험 demo-shop 계정만 재사용한다.
// 실제 업무 POST/상세 읽음 갱신·결제·실데이터 생성은 없다. context 종료/CI trap이 소유 자원을 정리한다.
const run = randomBytes(6).toString("hex");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = `tests/e2e/screenshots/current-shell-${sha}`;
const slug = "demo-shop";
const shop = `/api/shop/${slug}`;
const labels = (prefix: string) => Array.from({ length: 23 }, (_, i) => `${prefix} ${String(i).padStart(2, "0")}`);
const iso = new Date().toISOString();
const id = (kind: string, i: number) => `${run}-${kind}-${i}`;
const cursor = (n: number) => `${run}-c${n}`;
function start(q: URLSearchParams, key = "cursor") {
  const value = q.get(key);
  if (!value) return 0;
  expect([cursor(10), cursor(20)]).toContain(value);
  return value === cursor(10) ? 10 : 20;
}
function part<T>(items: T[], from: number) {
  return { items: items.slice(from, from + 10), next: from + 10 < items.length ? cursor(from + 10) : null };
}
test.beforeAll(async ({}, info) => {
  expect(process.env.CI).toBe("true");
  expect(process.env.GITHUB_JOB).toBe("e2e-smoke");
  expect(process.env.NODE_ENV).not.toBe("production");
  expect(info.config.workers).toBe(1);
  const db = new URL(assertTestDatabaseUrl(process.env.DATABASE_URL));
  expect(db.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(db.pathname).toBe("/live_obs_test");
  const base = new URL(String(info.project.use.baseURL));
  expect(base.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(base.port).toBe("3100");
  expect(process.env.E2E_PASSWORD).toBeTruthy();
  mkdirSync(evidence, { recursive: true });
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
async function mock(page: Page, path: string, body: (q: URLSearchParams, route: Route) => unknown | Promise<unknown>) {
  await page.route(url => url.pathname === path, async route => {
    expect(route.request().method()).toBe("GET");
    const json = await body(new URL(route.request().url()).searchParams, route);
    await route.fulfill({ status: 200, json });
  });
}
async function seller(page: Page) {
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", process.env.E2E_PASSWORD!);
  await expect(page).toHaveURL(/\/seller$/);
}
async function buyer(page: Page) {
  const base = new URL(String(test.info().project.use.baseURL));
  const r = await page.request.post(`${shop}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: process.env.E2E_PASSWORD }, headers: { origin: base.origin } });
  expect(r.status()).toBe(200);
}
function nav(page: Page) { return page.getByRole("navigation", { name: "페이지 이동", exact: true }); }
async function traverse(rows: Locator, texts: Locator, pager: Locator, names: string[], total = false) {
  const seen: string[] = [];
  for (let n = 1; n <= 3; n++) {
    await expect(rows).toHaveCount(n < 3 ? 10 : 3);
    await expect(texts).toHaveText(names.slice((n - 1) * 10, n * 10));
    await expect(pager.getByRole("button", { name: `${n}페이지`, exact: true })).toHaveAttribute("aria-current", "page");
    seen.push(...await texts.allTextContents());
    if (n < 3) await pager.getByRole("button", { name: "다음", exact: true }).click();
  }
  expect(seen).toEqual(names);
  expect(new Set(seen).size).toBe(23);
  await expect(pager.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await expect(pager.getByRole("button", { name: "마지막", exact: true })).toHaveCount(total ? 1 : 0);
  await pager.getByRole("button", { name: "이전", exact: true }).click();
  await expect(texts).toHaveText(names.slice(10, 20));
  await pager.getByRole("button", { name: "처음", exact: true }).click();
  await expect(texts).toHaveText(names.slice(0, 10));
  await expect(pager.getByRole("button", { name: "이전", exact: true })).toBeDisabled();
}
async function capture(page: Page, screen: string, rows: Locator, role: string, state: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await expect(rows).toHaveCount(10);
    await page.screenshot({ path: `${evidence}/${screen}-${width}.png`, fullPage: true });
    const metrics = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, devicePixelRatio, zoom: "UNVERIFIED" }));
    writeFileSync(`${evidence}/${screen}-${width}.json`, JSON.stringify({ sha, screen, route: new URL(page.url()).pathname, role, state, rowCount: 10, firstRow: await rows.first().innerText(), metrics }, null, 2));
  }
}

test("SA043: 200 제한의 전체 구매자 묶음 23명·사유·끝일·모든 쪽", async ({ page }) => {
  const names = labels("제한 구매자");
  const until = new Date(Date.now() + 10 * 86400000).toISOString();
  const restrictions = Array.from({ length: 200 }, (_, i) => {
    const n = i < 23 ? i : 0;
    return { id: id("restriction", i), buyerMemberId: id("member", n), reason: i === 23 ? "PAID_CANCEL" : "UNPAID_AUTO_CANCEL", startsAt: iso, endsAt: i === 23 ? until : iso, buyerMember: { broadcastNickname: names[n] } };
  });
  await mock(page, "/api/seller/purchase-restrictions", () => ({ restrictions }));
  await seller(page); await page.goto("/seller/purchase-restrictions");
  const rows = page.getByTestId("restriction-row");
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText("미입금 자동 취소 반복");
  await expect(rows.first()).toContainText("결제 후 취소 반복");
  await expect(rows.first().locator(".t-c1.c-alt")).toContainText(new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(until)));
  await expect(page.getByText(/최근 200건/)).toBeVisible();
  await capture(page, "SA-043", rows, "seller-owner", "first / 200 restrictions / 23 buyer groups");
  await traverse(rows, rows.locator("td:first-child .fw6"), page.getByRole("navigation", { name: "구매 제한 페이지 이동" }), names, true);
  restrictions.splice(1);
  await page.reload(); await expect(rows).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "구매 제한 페이지 이동" })).toHaveCount(0);
});

test("SA054: 방송 23개 커서 전 접근·전체 요약 유지·레이아웃 첫 쪽", async ({ page }) => {
  const names = labels("방송 이력");
  const items = names.map((title, i) => ({ id: id("broadcast", i), title, status: "ended", startedAt: iso, endedAt: iso, layout: "9x16", summary: { orders: 31, paidOrders: 30, sales: 12345, completed: 29, cancelled: 2, hits: 7 } }));
  await mock(page, "/api/seller/broadcast/history", q => {
    const p = part(q.get("layout") ? items.slice(0, 1) : items, start(q));
    return { items: p.items, nextCursor: p.next };
  });
  await seller(page); await page.goto("/seller/broadcasts");
  const rows = page.getByTestId("bh-list").locator("tr");
  await capture(page, "SA-054", rows, "seller-owner", "first / default KST month / 23 broadcasts");
  await expect(rows.first()).toContainText("12,345");
  await traverse(rows, page.getByTestId("bh-link"), nav(page), names);
  await nav(page).getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.getByTestId("bh-link").first()).toHaveText(names[10]);
  await page.getByLabel("레이아웃", { exact: true }).selectOption("16x9");
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/seller/broadcast/history" && new URL(r.url()).searchParams.get("layout") === "16x9");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  const r = await response; expect(new URL(r.url()).searchParams.has("cursor")).toBe(false);
  await expect(rows).toHaveCount(1); await expect(nav(page)).toHaveCount(0);
});

test("SA111: 일반 23개·첫 쪽 전체 고정 공지·전체 안 읽은 수·검색 초기화", async ({ page }) => {
  const names = labels("일반 공지");
  const item = (title: string, i: number, pinned = false) => ({ id: id(pinned ? "pin" : "notice", i), title, category: "GENERAL", isPinned: pinned, read: false, publishedAt: iso });
  const items = names.map((s, i) => item(s, i));
  await mock(page, "/api/seller/platform-notices", q => {
    const from = start(q); const p = part(q.get("q") ? items.slice(0, 1) : items, from);
    return { pinned: !from && !q.get("q") ? [item("고정 공지 1", 0, true), item("고정 공지 2", 1, true)] : [], items: p.items, nextCursor: p.next, unreadCount: 25 };
  });
  await seller(page); await page.goto("/seller/notices");
  const rows = page.getByTestId("notice-row");
  await expect(rows).toHaveCount(12);
  await expect(rows.first()).toContainText("고정 공지 1");
  const general = rows.filter({ hasNotText: "맨 위 고정" });
  await expect(page.getByText("새 글 25", { exact: true })).toBeVisible();
  await capture(page, "SA-111", general, "seller-owner", "first / 10 general + 2 separate pins / unread25");
  await traverse(general, general.locator("td:first-child a"), nav(page), names);
  await expect(rows).toHaveCount(12);
  await nav(page).getByRole("button", { name: "다음", exact: true }).click();
  await expect(rows).toHaveCount(10);
  await nav(page).getByRole("button", { name: "다음", exact: true }).click();
  await expect(rows).toHaveCount(3);
  items.splice(20);
  await nav(page).getByRole("button", { name: "3페이지", exact: true }).click();
  await expect(general.locator("td:first-child a")).toHaveText(names.slice(10, 20));
  await expect(nav(page).getByRole("button", { name: "2페이지", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav(page).getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await page.getByLabel("공지 검색").fill("일반 공지 00");
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/seller/platform-notices" && new URL(r.url()).searchParams.has("q"));
  await page.getByRole("button", { name: "검색", exact: true }).click();
  expect(new URL((await response).url()).searchParams.has("cursor")).toBe(false);
  await expect(rows).toHaveCount(1); await expect(nav(page)).toHaveCount(0);
});

test("SA113: 내 문의 23개·전체 상태/답변 평균 유지·상태 첫 쪽", async ({ page }) => {
  const names = labels("내 문의");
  const items = names.map((title, i) => ({ id: id("inquiry", i), title, category: "OTHER", status: "OPEN", createdAt: iso, lastMessageAt: iso, lastReplyAt: null, hasNewReply: false }));
  await mock(page, "/api/seller/platform-inquiries", q => {
    const p = part(q.get("status") ? items.slice(0, 1) : items, start(q));
    return { items: p.items, nextCursor: p.next, counts: { all: 23, open: 23, answered: 0, closed: 0 }, newReplyCount: 7, avgFirstReplyMinutes: 30 };
  });
  await seller(page); await page.goto("/seller/inquiries");
  const rows = page.getByTestId("inquiry-row");
  await capture(page, "SA-113", rows, "seller-owner", "first / owner whole scope / 23 inquiries");
  await expect(page.getByRole("button", { name: "전체 23", exact: true })).toBeVisible();
  await expect(page.getByText("답변 7", { exact: true })).toBeVisible();
  await expect(page.getByText(/평균 첫 답변 30분/)).toBeVisible();
  await traverse(rows, rows.locator("td:first-child a"), nav(page), names);
  await nav(page).getByRole("button", { name: "다음", exact: true }).click(); await expect(rows.locator("td a").first()).toHaveText(names[10]);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/seller/platform-inquiries" && new URL(r.url()).searchParams.get("status") === "OPEN");
  await page.getByRole("button", { name: "접수 23", exact: true }).click();
  expect(new URL((await response).url()).searchParams.has("cursor")).toBe(false);
  await expect(rows).toHaveCount(1); await expect(nav(page)).toHaveCount(0);
});

test("SA111: 다음 중복 요청 차단·검색 뒤 늦은 이전 커서 응답 무시", async ({ page }) => {
  const names = labels("지연 공지");
  const items = names.map((title, i) => ({ id: id("late-notice", i), title, category: "GENERAL", isPinned: false, read: false, publishedAt: iso }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let delayedReads = 0;
  await mock(page, "/api/seller/platform-notices", async q => {
    const from = start(q);
    if (from === 10) { delayedReads += 1; await gate; }
    const p = part(q.has("q") ? items.slice(22) : items, from);
    return { pinned: [], items: p.items, nextCursor: p.next, unreadCount: 23 };
  });
  await seller(page); await page.goto("/seller/notices");
  const rows = page.getByTestId("notice-row"); await expect(rows).toHaveCount(10);
  const requested = page.waitForRequest(r => new URL(r.url()).pathname === "/api/seller/platform-notices" && new URL(r.url()).searchParams.get("cursor") === cursor(10));
  await nav(page).getByRole("button", { name: "다음", exact: true }).click();
  const request = await requested;
  try {
    await nav(page).getByRole("button", { name: "다음", exact: true }).click();
    expect(delayedReads).toBe(1);
    await page.getByLabel("공지 검색").fill(names[22]);
    const searched = page.waitForResponse(r => new URL(r.url()).pathname === "/api/seller/platform-notices" && new URL(r.url()).searchParams.has("q"));
    await page.getByRole("button", { name: "검색", exact: true }).click();
    const current = await searched; expect(await current.finished()).toBeNull();
    await expect(rows.locator("td:first-child a")).toHaveText([names[22]]);
    const finished = page.waitForEvent("requestfinished", { predicate: r => r === request });
    release(); await finished;
    // 응답 완료 이후에도 현재 검색 목록·한 쪽 이동 숨김이 유지되어야 한다.
    await expect(rows.locator("td:first-child a")).toHaveText([names[22]]);
    await expect(nav(page)).toHaveCount(0);
  } finally { release(); }
});

test("SH021: 주문 23개·명시 limit10·기간 전체 건수·기간 초기화", async ({ page }) => {
  const names = labels("주문");
  const orders = names.map((orderNoLabel, i) => ({ id: id("order", i), orderNo: i + 1, orderNoLabel, status: "PAID", totalAmount: 1000, createdAt: iso, refundedAt: null, paymentDueAt: null, queue: null, items: [{ productNameSnapshot: "검수 상품", optionNameSnapshot: "기본", unitPrice: 1000, quantity: 1, imageUrl: null, optionId: null }], shipment: null }));
  await mock(page, `${shop}/orders`, q => {
    expect(q.get("limit")).toBe("10"); expect(q.has("from")).toBe(true); expect(q.has("to")).toBe(true);
    const p = part(orders, start(q)); return { orders: p.items, nextCursor: p.next, counts: { all: 23, pending: 0, inProgress: 23, done: 0, cancelled: 0, refunded: 0 } };
  });
  await buyer(page); await page.goto(`/shop/${slug}/orders`);
  const rows = page.locator(".ol-tbl tbody tr");
  await capture(page, "SH-021", rows, "buyer", "first / 3months / full period count23");
  await expect(page.getByRole("tab", { name: "전체 23", exact: true })).toBeVisible();
  await traverse(rows, rows.locator(".ol-date a"), nav(page), names);
  await nav(page).getByRole("button", { name: "다음", exact: true }).click(); await expect(rows.locator(".ol-date a").first()).toHaveText(names[10]);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === `${shop}/orders` && !new URL(r.url()).searchParams.has("cursor"));
  await page.getByRole("button", { name: "6개월", exact: true }).click(); await response;
  await expect(rows.locator(".ol-date a")).toHaveText(names.slice(0, 10));
  await expect(nav(page).getByRole("button", { name: "1페이지", exact: true })).toHaveAttribute("aria-current", "page");
});

test("SH029: 쓰기 상품·내 리뷰 각각 23개·독립 이동·고른 상품과 초안 유지", async ({ page }) => {
  const names = labels("리뷰 상품"); const reviewNames = labels("내 리뷰 상품");
  const writable = names.map((productName, i) => ({ orderItemId: id("item", i), productName, optionName: "기본", deliveredAt: iso, writableUntil: new Date(Date.now() + 7 * 86400000).toISOString() }));
  const reviews = reviewNames.map((productName, i) => ({ id: id("review", i), productName, rating: 5, body: "검수용 리뷰 내용입니다.", status: "VISIBLE", hiddenReason: null, hiddenNote: null, reply: null, repliedAt: null, rewardedAmount: 0, images: [], createdAt: iso, editable: true }));
  await mock(page, `${shop}/reviews`, q => {
    const w = part(writable, start(q, "writableCursor")); const r = part(reviews, start(q));
    return { writable: w.items, writableNextCursor: w.next, reviews: r.items, nextCursor: r.next, reward: { text: 100, photo: 200 } };
  });
  await page.route(url => url.pathname.startsWith(`${shop}/reviews/items/${run}-item-`), route => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: { item: { productName: names[0], optionName: "기본", quantity: 1, orderedAt: iso, deliveredAt: iso, reward: { text: 100, photo: 200 } } } });
  });
  await buyer(page); await page.goto(`/shop/${slug}/reviews`);
  const select = page.getByLabel("리뷰 쓸 상품", { exact: true }); const options = select.locator("option:not([hidden])");
  const writeNav = page.getByRole("group", { name: "리뷰 쓸 상품 페이지", exact: true }).getByRole("navigation");
  const reviewNav = page.getByRole("group", { name: "내 리뷰 페이지", exact: true }).getByRole("navigation");
  const rows = page.getByTestId("my-review");
  await capture(page, "SH-029", rows, "buyer", "first / 10 writable options + 10 own reviews");
  const draft = page.locator("#rv-body"); await draft.fill("쪽을 바꿔도 유지할 작성 중인 리뷰입니다.");
  const chosen = await select.inputValue();
  const seen: string[] = [];
  for (let n = 1; n <= 3; n++) {
    await expect(options).toHaveCount(n < 3 ? 10 : 3);
    await expect.poll(async () => (await options.allTextContents()).map(s => s.trim().split(" · ")[0])).toEqual(names.slice((n - 1) * 10, n * 10));
    await expect(writeNav.getByRole("button", { name: `${n}페이지`, exact: true })).toHaveAttribute("aria-current", "page");
    seen.push(...(await options.allTextContents()).map(s => s.trim().split(" · ")[0]));
    await expect(select).toHaveValue(chosen); await expect(draft).toHaveValue("쪽을 바꿔도 유지할 작성 중인 리뷰입니다.");
    await expect(rows).toHaveCount(10);
    if (n < 3) await writeNav.getByRole("button", { name: "다음", exact: true }).click();
  }
  expect(seen).toEqual(names); await expect(writeNav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await traverse(rows, rows.locator("td:first-child b"), reviewNav, reviewNames);
  await expect(writeNav.getByRole("button", { name: "3페이지", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(select).toHaveValue(chosen); await expect(draft).toHaveValue("쪽을 바꿔도 유지할 작성 중인 리뷰입니다.");
  await writeNav.getByRole("button", { name: "처음", exact: true }).click(); await expect(options).toHaveCount(10);
});

test("SH030: 고정 포함 공지 23개 커서·FAQ 전체 배열 23개·분류/검색 첫 쪽", async ({ page }) => {
  const names = labels("쇼핑몰 공지"); const faqNames = labels("자주 묻는 질문");
  const notices = names.map((title, i) => ({ id: id("shopnotice", i), title, category: "안내", isPinned: i === 0, createdAt: iso }));
  const faqs = faqNames.map((title, i) => ({ id: id("faq", i), title, category: i < 20 ? "주문" : "배송", body: "합성 질문 답변입니다." }));
  await mock(page, `${shop}/notices`, q => { const p = part(notices, start(q)); return { notices: p.items, nextCursor: p.next }; });
  await mock(page, `${shop}/faqs`, q => ({ faqs: q.get("q") ? faqs.slice(20) : faqs, categories: ["주문", "배송"] }));
  await page.goto(`/shop/${slug}/help`);
  const rows = page.locator(".help-tbl tbody tr");
  await capture(page, "SH-030-notices", rows, "public", "first / existing pin included in 10 / 23 notices");
  await expect(rows.first()).toContainText("고정");
  await traverse(rows, rows.locator("td:first-child a"), nav(page), names);
  await page.getByRole("tab", { name: "자주 묻는 질문", exact: true }).click();
  const faqRows = page.locator(".help-faq"); const faqNav = page.getByRole("navigation", { name: "자주 묻는 질문 페이지 이동", exact: true });
  await capture(page, "SH-030-faq", faqRows, "public", "first / 23 FAQs / full category options");
  const seen: string[] = [];
  for (let n = 1; n <= 3; n++) {
    await expect(faqRows).toHaveCount(n < 3 ? 10 : 3);
    const text = await faqRows.locator("summary").allTextContents();
    expect(text.map(s => s.trim().replace(/^(주문|배송)/, "").trim())).toEqual(faqNames.slice((n - 1) * 10, n * 10));
    seen.push(...text.map(s => s.trim().replace(/^(주문|배송)/, "").trim()));
    if (n < 3) await faqNav.getByRole("button", { name: "다음", exact: true }).click();
  }
  expect(seen).toEqual(faqNames); await expect(faqNav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await page.getByRole("group", { name: "분류", exact: true }).getByRole("button", { name: "배송", exact: true }).click();
  await expect(faqRows).toHaveCount(3); await expect(faqNav).toHaveCount(0);
  await page.getByRole("group", { name: "분류", exact: true }).getByRole("button", { name: "전체", exact: true }).click();
  await expect(faqRows).toHaveCount(10); await faqNav.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByLabel("자주 묻는 질문 검색").fill("질문");
  await page.locator(".help-search").getByRole("button", { name: "검색", exact: true }).click();
  await expect(faqRows).toHaveCount(3); await expect(faqNav).toHaveCount(0);
  await expect(page.getByRole("group", { name: "분류", exact: true }).getByRole("button", { name: "주문", exact: true })).toBeVisible();
});
