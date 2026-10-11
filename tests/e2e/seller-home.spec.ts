import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { itemSummaryText, payBadge, type OrderRow } from "../../components/seller/orders";
import { won } from "../../components/seller/format";

// SA-002 파트너스 홈: 오늘 처리할 일 → 오늘 성과 → 방송. 화면 숫자는 같은 API 값과 같아야 한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller");
  await submitSellerLogin(page, email, PASSWORD);
  await page.waitForURL((u) => !u.pathname.startsWith("/seller/login"));
  await page.goto("/seller");
}

type Tasks = { total: number; items: { key: string; count: number; href: string }[] };

async function captureMobileHome(page: Page, name: string, role: "STORE_OWNER" | "STAFF", readinessFailure?: { error: unknown }) {
  let geometryFailure = readinessFailure;
  let drawerOpen = false;
  try {
    await expect.poll(() => page.locator(".gnb-logo img").evaluate((el) => el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0)).toBe(true);
    drawerOpen = await page.locator(".cs").evaluate((el) => el.classList.contains("nav-open"));
    if (page.viewportSize()?.width === 390) await expect.poll(() => page.locator(".lnb").evaluate((el, open) => {
      const r = el.getBoundingClientRect();
      const width = parseFloat(getComputedStyle(el).width);
      const moving = el.getAnimations().some((a) => a instanceof CSSTransition && a.playState === "running");
      return !moving && (open ? r.left === 0 && r.right === width : r.right <= 0);
    }, drawerOpen)).toBe(true);
  } catch (error) { geometryFailure ??= { error }; }
  try {
    const sidebar = await page.evaluate(() => { const el = document.querySelector(".lnb"); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: parseFloat(getComputedStyle(el).width), transitions: el.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === "running").length }; });
    const metrics = await page.evaluate(() => {
      const main = document.querySelector("main.main");
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const table = main?.querySelector(".tbl"); const scroll = table?.parentElement;
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null }, height: document.documentElement.scrollHeight, drawerOpen: !!document.querySelector(".cs.nav-open"),
        amounts: Array.from(main?.querySelectorAll(".stat .v") ?? []).map((el) => { const range = document.createRange(); range.selectNodeContents(el); return { text: el.textContent?.trim(), label: el.closest(".stat")?.querySelector(".t-l2")?.textContent?.trim(), lines: range.getClientRects().length, client: el.clientWidth, scroll: el.scrollWidth }; }),
        main: main ? box(main) : null, overflow: document.documentElement.scrollWidth > innerWidth,
        table: table ? { ...box(table), headers: Array.from(table.querySelectorAll("thead th")).map((el) => ({ text: el.textContent?.trim(), ...box(el) })) } : null,
        scroll: scroll ? { ...box(scroll), overflowX: getComputedStyle(scroll).overflowX, clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth, scrollLeft: scroll.scrollLeft } : null,
        rows: table ? Array.from(table.querySelectorAll("tbody tr")).map((row) => ({ text: row.textContent?.trim(), ...box(row), cells: Array.from(row.querySelectorAll("td")).map((el) => ({ text: el.textContent?.trim(), whiteSpace: getComputedStyle(el).whiteSpace, ...box(el) })), actions: Array.from(row.querySelectorAll("a,button")).map((el) => ({ text: el.textContent?.trim(), href: el.getAttribute("href"), ...box(el) })) })) : [],
      };
    });
    const brand = await page.evaluate(() => {
      const logo = document.querySelector(".gnb-logo"); const header = logo?.closest(".gnb"); const image = logo?.querySelector("img"); const word = logo?.querySelector("span:not(.gnb-sub)");
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const range = document.createRange(); if (word) range.selectNodeContents(word);
      return logo && header && image instanceof HTMLImageElement && word ? { href: logo.getAttribute("href"), role: logo.querySelector(".gnb-sub")?.textContent, word: word.textContent, wordLines: range.getClientRects().length, color: getComputedStyle(word).color, background: getComputedStyle(image).backgroundColor, src: image.getAttribute("src"), loaded: image.complete && image.naturalWidth > 0, naturalWidth: image.naturalWidth, legacy: logo.querySelectorAll(".logo-sym,.logo-word").length, headerText: header instanceof HTMLElement ? header.innerText : header.textContent, image: box(image), wordBox: box(word), logo: box(logo), header: box(header) } : null;
    });
    const headerLayout = await page.evaluate(() => {
      const header = document.querySelector(".gnb"); const logo = header?.querySelector(".gnb-logo"); const nav = header?.querySelector(".gnb-nav"); const util = header?.querySelector(".gnb-util"); const logout = util?.querySelector(".util-desk .util-btn");
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
      const textBox = (el: Element) => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); return { text: el.textContent?.trim(), lines: range.getClientRects().length, textLeft: r.left, textRight: r.right, ...box(el) }; };
      const controls = Array.from(header?.querySelectorAll(".gnb-nav > *, .gnb-util .gnb-ic, .util-desk > *") ?? []).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map(textBox);
      return header && logo && nav && util ? { header: box(header), client: header.clientWidth, scroll: header.scrollWidth, logoMarginRight: getComputedStyle(logo).marginRight, nav: box(nav), menuPadding: Array.from(nav.children).map((el) => ({ left: getComputedStyle(el).paddingLeft, right: getComputedStyle(el).paddingRight })), util: box(util), controls, logout: logout && logout.getBoundingClientRect().width > 0 ? textBox(logout) : null } : null;
    });
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const evidence = `tests/e2e/screenshots/current-shell-${sourceSha}`;
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: `tests/e2e/screenshots/${name}.png`, fullPage: true });
    if (drawerOpen) await page.screenshot({ path: `tests/e2e/screenshots/${name}-viewport.png`, fullPage: false });
    writeFileSync(`${evidence}/${name}.json`, JSON.stringify({ sourceSha, route: new URL(page.url()).pathname, role, state: geometryFailure || !metrics.main ? "not-ready" : drawerOpen ? "drawer-open" : "content", sidebar, brand, headerLayout, ...metrics }, null, 2));
    if (geometryFailure) throw geometryFailure.error;
    expect(brand).not.toBeNull();
    if (!brand) throw new Error("공통 헤더 로고가 없습니다");
    expect(brand.href).toBe("/seller"); expect(brand.role).toBe("파트너스"); expect(brand.word).toBe("streamshop");
    expect(brand.src).toContain("streamshop-partners-180-20261010"); expect(brand.loaded).toBe(true); expect(brand.legacy).toBe(0);
    expect(brand.headerText).not.toMatch(/\bONQ\b|OnAirCue|온에어큐/); expect(brand.wordLines).toBe(1);
    expect(brand.color).toBe("rgb(255, 255, 255)"); expect(brand.background).toBe("rgb(255, 255, 255)");
    expect(brand.image.width).toBe(22); expect(brand.image.height).toBe(22);
    for (const box of [brand.image, brand.wordBox]) { expect(box.left).toBeGreaterThanOrEqual(brand.logo.left); expect(box.right).toBeLessThanOrEqual(brand.logo.right); expect(box.top).toBeGreaterThanOrEqual(brand.header.top); expect(box.bottom).toBeLessThanOrEqual(brand.header.bottom); }
    expect(brand.logo.left).toBeGreaterThanOrEqual(0); expect(brand.logo.right).toBeLessThanOrEqual(metrics.viewport.width);
    if (metrics.viewport.width >= 1024) {
      expect(headerLayout).not.toBeNull();
      if (!headerLayout?.logout) throw new Error("데스크톱 헤더의 로그아웃 버튼이 없습니다");
      expect(headerLayout.header.left).toBe(0); expect(headerLayout.header.right).toBe(metrics.viewport.width);
      expect(headerLayout.scroll).toBeLessThanOrEqual(headerLayout.client);
      expect(headerLayout.logout.text).toBe("로그아웃"); expect(headerLayout.logout.lines).toBe(1);
      expect(headerLayout.logout.left).toBeGreaterThanOrEqual(0); expect(headerLayout.logout.right).toBeLessThanOrEqual(metrics.viewport.width);
      expect(headerLayout.logout.textLeft).toBeGreaterThanOrEqual(headerLayout.logout.left); expect(headerLayout.logout.textRight).toBeLessThanOrEqual(headerLayout.logout.right);
      for (const control of headerLayout.controls) { expect(control.left).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(metrics.viewport.width); }
    }
    expect(metrics.main).not.toBeNull();
    return metrics;
  } catch (error) { throw geometryFailure ? geometryFailure.error : error; }
}

test("대표자: 오늘 처리할 일 → 오늘 성과 → 방송 순서로 보이고, 처리할 일 숫자는 API와 같다", async ({ page }) => {
  await open(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByRole("heading", { name: "홈", exact: true })).toBeVisible();

  const headings = page.locator(".home-sec-h h2");
  await expect(headings).toHaveText([/오늘 처리할 일/, /오늘 성과/, /방송/]);

  const api = (await page.request.get("/api/seller/today-tasks").then((r) => r.json())) as Tasks;
  expect(api.items.map((i) => i.key)).toEqual(["depositPending", "shipPending", "returnRequested", "inquiryWaiting", "stockOut", "stockLow"]);
  for (const t of api.items) {
    const tile = page.getByTestId(`home-task-${t.key}`);
    await expect(tile).toBeVisible();
    await expect(tile.locator(".v")).toHaveText(t.count.toLocaleString("ko-KR"));
    await expect(tile).toHaveAttribute("href", t.href);
  }
  await expect(page.getByTestId("home-performance")).toBeVisible();
  await expect(page.getByTestId("home-performance").locator(".stat")).toHaveCount(4);
  await expect(page.getByTestId("seller-home-mobile-notice")).toBeHidden();
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await captureMobileHome(page, `seller-home-store-owner-${width}`, "STORE_OWNER");
  }
});

test("처리할 일을 누르면 그 처리 화면으로 간다", async ({ page }) => {
  await open(page, "demo-owner@example.com");
  await page.getByTestId("home-task-depositPending").click();
  await expect(page).toHaveURL(/\/seller\/orders\/deposits$/);
});

test("주문·배송 권한만 있는 직원: 읽을 수 있는 처리할 일만 보이고 성과·방송 구역은 감춘다", async ({ page }) => {
  await open(page, "demo-viewer@example.com");
  await expect(page.getByRole("heading", { name: "홈", exact: true })).toBeVisible();
  await expect(page.getByTestId("home-task-depositPending")).toBeVisible();
  await expect(page.getByTestId("home-task-shipPending")).toBeVisible();
  await expect(page.getByTestId("home-task-inquiryWaiting")).toHaveCount(0);
  await expect(page.getByTestId("home-task-stockOut")).toHaveCount(0);
  await expect(page.getByTestId("home-performance")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("seller-home-mobile-notice")).toBeVisible();
  await expect(page.getByTestId("bc-opening")).toHaveCount(0);
  await expect(page.getByTestId("bc-waiting")).toHaveCount(0);
  await captureMobileHome(page, "seller-home-mobile-staff-390", "STAFF");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});

test("390 폭에서도 가로 스크롤 없이 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "demo-owner@example.com");
  await expect(page.getByTestId("home-tasks")).toBeVisible();
  const notice = page.getByTestId("seller-home-mobile-notice");
  await expect(notice).toHaveText("모바일에서는 홈 화면을 제공합니다 상세 관리 업무는 PC에서 이용해 주십시오");
  await expect(notice).toBeVisible();
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const overview = await page.request.get(`/api/seller/stats/overview?from=${today}&to=${today}`);
  expect(overview.status()).toBe(200);
  const performance = (await overview.json()).summary.current;
  for (const [label, value] of [["결제된 매출", performance.revenue], ["주문 1건당 평균 금액", performance.averageOrderValue]] as const) {
    await expect(page.getByTestId("home-performance").locator(".stat").filter({ has: page.getByText(label, { exact: true }) }).locator(".v")).toHaveText(value === null ? "—" : `${value.toLocaleString("ko-KR")}원`);
  }
  const metrics = await captureMobileHome(page, "seller-home-mobile-store-owner-390", "STORE_OWNER");
  for (const amount of metrics.amounts.filter((a) => a.label === "결제된 매출" || a.label === "주문 1건당 평균 금액")) { expect(amount.lines).toBe(1); expect(amount.scroll).toBeLessThanOrEqual(amount.client); }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await expect(page.locator(".cs")).toHaveClass(/nav-open/);
  await captureMobileHome(page, "seller-home-mobile-store-drawer-390", "STORE_OWNER");
  await page.goBack();
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "입금 확인", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/orders\/deposits(?:\?|$)/);
  await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
  await expect(notice).toHaveCount(0);
});

type Onboarding = { completed: boolean; dismissed: boolean; doneCount: number; total: number };

test("주문 목록: 기존 STORE 대표자가 두 PC 폭에서 실제 행·금액·조회 행동을 읽는다", async ({ page }) => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  await open(page, "demo-owner@example.com");
  const mutations: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/seller/orders") && !["GET", "HEAD"].includes(r.method())) mutations.push(r.method()); });
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const evidence = `tests/e2e/screenshots/current-shell-${sourceSha}`;
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    let failure: { error: unknown } | undefined;
    let data: { orders: OrderRow[] } | undefined;
    try {
      const [response] = await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === "/api/seller/orders" && r.request().method() === "GET"), page.goto("/seller/orders")]);
      expect(response.status()).toBe(200); data = await response.json();
      await expect(page.getByRole("heading", { name: "주문", exact: true })).toBeVisible();
      await expect(page.getByTestId("order-row").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
    } catch (error) { failure = { error }; }
    const metrics = await captureMobileHome(page, `SA-021-STORE-${width}`, "STORE_OWNER", failure);
    expect(metrics.overflow).toBe(false); expect(metrics.table?.headers).toHaveLength(7);
    expect(metrics.scroll?.overflowX).toBe("auto");
    if (!data?.orders.length) throw new Error("주문 조회 응답에 대상 행이 없습니다");
    await expect(page.getByTestId("order-row")).toHaveCount(data.orders.length);
    for (const order of data.orders) {
      const row = page.getByTestId("order-row").filter({ has: page.locator(`a.ord-link[href="/seller/orders/${order.id}"]`) });
      await expect(row.locator("td").nth(1)).toHaveText(order.buyer.broadcastNickname);
      await expect(row.locator("td").nth(2)).toHaveText(itemSummaryText(order.itemSummary));
      expect(await row.locator("td").nth(3).evaluate((el) => Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("").trim())).toBe(won(order.totalAmount));
      if (order.refundedAmount > 0) await expect(row.locator(".ord-rf")).toHaveText(`환불 ${won(order.refundedAmount)}`);
      else await expect(row.locator(".ord-rf")).toHaveCount(0);
      await expect(row.locator("td").nth(4).locator(".bdg")).toHaveText(payBadge(order).label);
      await expect(row.getByRole("link", { name: "환불 처리", exact: true })).toHaveCount(order.refundable ? 1 : 0);
    }
    const refundable = data.orders.find((o) => o.refundable);
    if (!refundable) throw new Error("조회 fixture에 관리 행동을 확인할 주문이 없습니다");
    await page.locator(".ord-scroll").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    const action = page.getByTestId("order-row").filter({ has: page.locator(`a.ord-link[href="/seller/orders/${refundable.id}"]`) }).getByRole("link", { name: "환불 처리", exact: true });
    await action.focus(); await expect(action).toBeFocused();
    const access = await action.evaluate((el) => { const r = el.getBoundingClientRect(); const container = el.closest("table")?.parentElement; const scroll = container?.getBoundingClientRect(); return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null }, left: r.left, right: r.right, containerLeft: scroll?.left, containerRight: scroll?.right, scrollLeft: container?.scrollLeft, focused: document.activeElement === el, href: el.getAttribute("href") }; });
    await page.screenshot({ path: `${evidence}/SA-021-actions-${width}.png`, fullPage: false });
    writeFileSync(`${evidence}/SA-021-actions-${width}.json`, JSON.stringify({ sourceSha, role: "STORE_OWNER", route: new URL(page.url()).pathname, state: "actions-focused", ...access }, null, 2));
    expect(access.href).toBe(`/seller/orders/${refundable.id}?refund=1`);
    expect(access.containerLeft).toBeDefined(); expect(access.containerRight).toBeDefined();
    expect(access.left).toBeGreaterThanOrEqual(access.containerLeft!); expect(access.right).toBeLessThanOrEqual(access.containerRight!);
    const longest = data.orders.reduce((a, b) => (a.itemSummary.firstProductName?.length ?? 0) >= (b.itemSummary.firstProductName?.length ?? 0) ? a : b);
    const detailLink = page.locator(`a.ord-link[href="/seller/orders/${longest.id}"]`);
    await detailLink.focus(); await expect(detailLink).toBeFocused(); await detailLink.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/seller/orders/${longest.id}$`));
    await expect(page.getByRole("heading", { name: "주문 상품", exact: true })).toBeVisible();
    if (!longest.itemSummary.firstProductName) throw new Error("원문을 확인할 상품명이 없습니다");
    await expect(page.locator("section", { has: page.getByRole("heading", { name: "주문 상품", exact: true }) }).getByText(longest.itemSummary.firstProductName, { exact: true }).first()).toBeVisible();
  }
  expect(mutations).toEqual([]);
});

test("주문 권한 음성: 기존 주문·배송 권한 없는 직원은 조회 목록·메뉴를 제공받지 않는다", async ({ page }) => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  await open(page, "demo-staff@example.com");
  expect((await page.request.get("/api/seller/orders")).status()).toBe(403);
  await expect(page.getByRole("link", { name: "주문", exact: true })).toHaveCount(0);
  await page.goto("/seller/orders");
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다", { exact: true })).toBeVisible();
  await expect(page.getByText("대표자에게 허용해 달라고 요청해 주십시오 · 필요한 권한: 주문·배송", { exact: true })).toBeVisible();
  await expect(page.getByTestId("order-row")).toHaveCount(0);
});

test("시작하기 띠: 온보딩이 끝나지 않았을 때만 진행 N/M을 보이고, 닫으면 서버에 저장돼 사라지고, 다시 열면 돌아온다", async ({ page }) => {
  await open(page, "demo-owner@example.com");
  const post = (action: string) =>
    page.evaluate(async (a) => (await fetch("/api/seller/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: a }) })).status, action);
  expect(await post("reopen")).toBe(200);
  await page.reload();
  const state = (await page.request.get("/api/seller/onboarding").then((r) => r.json())) as Onboarding;
  const strip = page.getByTestId("home-onboarding");
  if (state.completed) {
    // 모두 끝낸 계정은 띠가 없다
    await expect(page.getByTestId("home-tasks")).toBeVisible();
    await expect(strip).toHaveCount(0);
    return;
  }
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(`${state.doneCount}/${state.total} 완료`);
  await expect(strip.getByRole("link", { name: "이어서 하기" })).toHaveAttribute("href", "/seller/onboarding");
  await strip.getByRole("button", { name: "시작하기 안내 숨기기" }).click();
  await page.getByRole("dialog", { name: "시작하기 안내를 숨기시겠습니까?" }).getByRole("button", { name: "숨기기" }).click();
  await expect(strip).toHaveCount(0);
  expect(((await page.request.get("/api/seller/onboarding").then((r) => r.json())) as Onboarding).dismissed).toBe(true);
  await page.reload();
  await expect(page.getByTestId("home-tasks")).toBeVisible();
  await expect(strip).toHaveCount(0);
  expect(await post("reopen")).toBe(200);
  await page.reload();
  await expect(strip).toBeVisible();
});
