import { PrismaClient } from "@prisma/client";
import { expect, test, type Page, type Response } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 홈(MA-001): 매출 요약과 「오늘 처리할 일」(숫자·이동), 기간별 주문·결제·성장·상위 5 파트너스·구독 매출, 일부 통계가 실패해도 나머지는 보인다.
// 계정·파트너스·문의·주문은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `hm-cs-${run}@example.com`;
const suEmail = `hm-su-${run}@example.com`;
const topShop = `상위몰 ${run}`;
const pendingShop = `대기몰 ${run}`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email, passwordHash, name: "상담", role: "CS" },
      { email: suEmail, passwordHash, name: "최고", role: "SUPER_ADMIN" },
    ],
  });
  await db.seller.create({ data: { slug: `hm-p-${run}`, shopName: pendingShop, status: "PENDING" } });
  const seller = await db.seller.create({ data: { slug: `hm-t-${run}`, shopName: topShop, status: "ACTIVE", approvedAt: new Date() } });
  const user = await db.sellerUser.create({ data: { sellerId: seller.id, email: `hm-owner-${run}@example.com`, passwordHash, name: "대표", isOwner: true } });
  const inq = await db.platformInquiry.create({ data: { sellerId: seller.id, createdBySellerUserId: user.id, category: "OTHER", title: `홈 문의 ${run}`, lastMessageAt: new Date() } });
  await db.platformInquiryMessage.create({ data: { sellerId: seller.id, inquiryId: inq.id, authorType: "SELLER_USER", sellerUserId: user.id, body: "내용입니다." } });
  const grade = await db.memberGrade.create({ data: { sellerId: seller.id, displayName: "일반", sortOrder: 0, systemKey: "BASIC" } });
  const buyer = await db.buyerMember.create({
    data: { sellerId: seller.id, gradeId: grade.id, loginId: `hm${run}`, passwordHash: "x", name: "구매자", phone: `010${String(parseInt(run, 16)).padStart(8, "0").slice(-8)}`, broadcastNickname: "닉", ciHash: `ci-${run}`, identityVerifiedAt: new Date(), birthDate: new Date("1990-01-01") },
  });
  await db.order.create({ data: { sellerId: seller.id, orderNo: 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 123_456, paidAt: new Date() } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, who = email) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(who);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function openStatus(page: Page) {
  await page.locator(".lnb-sec.on").getByRole("link", { name: "상세 현황", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/home\/status$/);
  await expect(page.getByRole("heading", { name: "상세 현황", level: 1 })).toBeVisible();
}

async function captureHome(page: Page, name: string, role: "CS" | "SUPER_ADMIN") {
  const metrics = await page.locator("main.ma-home").evaluate((main) => {
    const rows = (selector: string) => Array.from(main.querySelectorAll(selector)).map((el) => {
      const range = document.createRange(); range.selectNodeContents(el);
      return { text: el.textContent?.trim(), whiteSpace: getComputedStyle(el).whiteSpace, lines: range.getClientRects().length, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth };
    });
    const top = main.querySelector('[data-testid="stats-top"] table');
    const bounds = main.getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, documentHeight: document.documentElement.scrollHeight, mainHeight: main.scrollHeight, firstPanel: main.querySelector("section")?.getAttribute("data-testid"), amounts: rows(".sts-kpis .stat .v"), top: top ? { columns: top.querySelectorAll("thead th").length, width: top.getBoundingClientRect().width, scrollWidth: top.scrollWidth, availableWidth: top.parentElement?.clientWidth } : null, mainTop: bounds.top };
  });
  if (metrics.viewport.width >= 1024) {
    for (const amount of metrics.amounts) { expect(amount.whiteSpace).toBe("nowrap"); expect(amount.lines).toBe(1); expect(amount.scrollWidth).toBeLessThanOrEqual(amount.clientWidth); }
    if (metrics.top) { expect(metrics.top.columns).toBe(8); expect(metrics.top.availableWidth).toBeDefined(); expect(metrics.top.scrollWidth).toBeLessThanOrEqual(metrics.top.availableWidth!); }
  }
  await page.screenshot({ path: `tests/e2e/screenshots/${name}.png`, fullPage: true });
  writeFileSync(`tests/e2e/screenshots/${name}.json`, JSON.stringify({ sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), route: new URL(page.url()).pathname, role, ...metrics }, null, 2));
}

async function expectChartPlacement(page: Page, width: number) {
  await expect(page.locator(".ma-home-line svg")).toBeVisible();
  const revenue = await page.getByTestId("stats-orders").boundingBox();
  const orders = await page.getByTestId("stats-order-series").boundingBox();
  const grid = await page.locator(".ma-home-grid").boundingBox();
  const chart = await page.locator(".ma-home-line svg").boundingBox();
  expect(revenue && orders && grid && chart).toBeTruthy();
  expect(chart!.width).toBeGreaterThan(revenue!.width - 70);
  expect(Math.abs(revenue!.width - grid!.width)).toBeLessThan(1);
  expect(orders!.y).toBeGreaterThanOrEqual(revenue!.y + revenue!.height);
  expect(chart!.height).toBeLessThanOrEqual(140);
  const top = await page.getByTestId("stats-top").boundingBox();
  expect(top).not.toBeNull();
  expect(Math.abs(top!.width - grid!.width)).toBeLessThan(1);
  if (width === 390) expect(Math.abs(revenue!.width - orders!.width)).toBeLessThan(1);
}

async function expectDateAxes(page: Page, period?: { days: number; orders: string[]; growth: string[] }) {
  await expect(page.locator(".ma-home .sts-x")).toHaveCount(5);
  for (const [panel, title] of [
    ["stats-order-series", "일별 들어온 주문"],
    ["stats-order-series", "일별 결제된 주문"],
    ["stats-growth", "일별 가입 신청"],
    ["stats-growth", "일별 시작한 방송"],
    ["stats-subscriptions", "월별 받은 구독료"],
  ]) {
    // 기간별 조회가 서로 다른 시각에 교체돼도 다른 차트의 nth로 바뀌지 않도록 고정한다.
    const chart = page.getByTestId(panel).locator(".sts-chart").filter({ has: page.getByRole("img", { name: `${title} 그래프`, exact: true }) });
    const axis = chart.locator(".sts-x");
    const labels = axis.locator("span:visible");
    await expect(labels).toHaveCount(2);
    // 기간 조회가 축을 교체할 수 있으므로 연결 상태·눈금·좌표를 같은 DOM 순간에 확인한다.
    const measure = () => axis.evaluate((el) => {
      const visible = Array.from(el.querySelectorAll("span")).filter((span) => span.getClientRects().length > 0);
      const rect = (node: Element | undefined) => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: r.x, width: r.width };
      };
      return { connected: el.isConnected, labels: visible.map((span) => span.textContent?.trim()), first: rect(visible[0]), last: rect(visible.at(-1)), box: rect(el) };
    }, undefined, { timeout: 500 });
    const expected = panel === "stats-order-series" ? period?.orders : panel === "stats-growth" ? period?.growth : undefined;
    let snapshot: Awaited<ReturnType<typeof measure>> | undefined;
    try {
      await expect.poll(async () => {
        try { snapshot = await measure(); } catch { snapshot = undefined; return false; }
        return snapshot.connected && snapshot.labels.length === 2 &&
          [snapshot.first, snapshot.last, snapshot.box].every((r) => r !== null && Number.isFinite(r.x) && r.width > 0) &&
          (!expected || (snapshot.labels[0] === expected[0] && snapshot.labels[1] === expected[1]));
      }, { timeout: 5_000 }).toBe(true);
    } catch {
      throw new Error(JSON.stringify({ width: page.viewportSize()?.width, days: period?.days ?? 30, title, count: snapshot?.labels.length ?? 0, connected: snapshot?.connected ?? false }));
    }
    const { first, last, box } = snapshot!;
    expect(first && last && box).toBeTruthy();
    expect(first!.x).toBeGreaterThanOrEqual(box!.x - 1);
    expect(last!.x + last!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
    expect(first!.x + first!.width).toBeLessThanOrEqual(last!.x);
    for (const label of await labels.all()) await expect(label).toHaveText(/^\d{4}\.\d{2}(?:\.\d{2})?$/);
    await chart.locator("svg g").first().hover();
    await expect(chart.locator(".sts-tip")).toContainText((await labels.first().innerText()).trim());
  }
  await page.getByRole("heading", { level: 1 }).hover();
}

test("매출이 먼저 보이고 오늘 처리할 일과 상세 현황의 정보·실링크가 유지된다", async ({ page }) => {
  await login(page);
  const api = await (await page.request.get("/api/admin/today-tasks")).json();
  const count = (key: string) => api.items.find((i: { key: string }) => i.key === key).count;
  expect(count("signupPending")).toBeGreaterThan(0);
  expect(count("inquiryOpen")).toBeGreaterThan(0);
  const tasks = page.getByTestId("today-tasks");
  await expect(tasks.getByTestId("today-task-signupPending")).toContainText(`${count("signupPending")}건`);
  await expect(tasks.getByTestId("today-task-inquiryOpen")).toContainText(`${count("inquiryOpen")}건`);
  await expect(tasks.locator('[data-testid^="today-task-"]')).toHaveCount(8);
  await expect(tasks.getByTestId("today-task-inquiryOpen")).toContainText("파트너스 문의");
  await expect(page.getByTestId("today-tasks-at")).toContainText("집계");
  await expect(page.getByTestId("infra-card")).toHaveCount(0); // 인프라 · 비용 카드는 최고관리자에게만 보인다
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const month = await page.request.get(`/api/admin/stats/subscriptions?from=${today.slice(0, 7)}-01&to=${today}`);
  expect(month.status()).toBe(200);
  const subscriptions = await month.json();
  const money = (value: number) => `${value.toLocaleString("ko-KR")}원`;
  const subscriptionPanel = page.getByTestId("home-revenue-subscriptions");
  await expect(subscriptionPanel.locator(".stat").filter({ hasText: "수납 구독료" }).locator(".v")).toHaveText(money(subscriptions.current.revenue));
  await expect(subscriptionPanel.locator(".stat").filter({ hasText: "구독 환불" }).locator(".v")).toHaveText(money(subscriptions.current.refundAmount));
  for (const days of [7, 90, 30]) {
    const from = new Date(Date.now() - (days - 1) * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
    const request = page.waitForResponse((response) => { const url = new URL(response.url()); return url.pathname === "/api/admin/stats/orders" && url.searchParams.get("from") === from && url.searchParams.get("to") === today; });
    await page.getByRole("button", { name: `최근 ${days}일`, exact: true }).click();
    const response = await request;
    expect(response.status()).toBe(200);
    const orders = await response.json();
    const orderPanel = page.getByTestId("home-revenue-orders");
    await expect(orderPanel).toContainText(`최근 ${days}일`);
    for (const [label, value] of [["주문 결제액", orders.current.revenue], ["주문 환불", orders.current.refundAmount], ["환불 제외 결제액", orders.current.netRevenue]] as const) {
      await expect(orderPanel.locator(".stat").filter({ hasText: label }).locator(".v")).toHaveText(money(value));
    }
    await expect(subscriptionPanel.locator(".stat").filter({ hasText: "수납 구독료" }).locator(".v")).toHaveText(money(subscriptions.current.revenue));
  }
  await expect(page.locator(".ma-home-content > .ma-home-revenue")).toBeVisible();
  await expect(page.getByTestId("stats-orders")).toHaveCount(0);
  const revenueBox = await page.locator(".ma-home-revenue").boundingBox();
  const taskBox = await tasks.boundingBox();
  expect(revenueBox && taskBox).toBeTruthy();
  expect(revenueBox!.y + revenueBox!.height).toBeLessThanOrEqual(taskBox!.y);
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".ma-home-revenue .stat .v")).toHaveCount(5);
    for (const amount of await page.locator(".ma-home-revenue .stat .v").all()) {
      await expect(amount).toHaveCSS("white-space", "nowrap");
      expect(await amount.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await captureHome(page, `admin-home-compact-${width}`, "CS");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStatus(page);
  await expect(page.locator(".ma-home-kpis > section")).toHaveCount(6);
  await expect(page.getByTestId("home-operations")).toContainText("실시간 감시");
  await expect(page.getByTestId("home-db-metrics")).toHaveCount(0);
  await expect(page.getByTestId("home-admin-activity")).toHaveCount(0);
  await expect(page.locator(".ma-home-grid")).toHaveCSS("grid-template-columns", /^(\d+(\.\d+)?px) (\d+(\.\d+)?px)$/);
  await expectChartPlacement(page, 1440);
  await expectDateAxes(page);
  await expect(page.locator('.ma-home [aria-busy="true"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await captureHome(page, "admin-home-status-1440", "CS");
  for (const w of [1024, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "상세 현황", level: 1 })).toBeVisible();
    await expect(page.locator(".ma-home-grid")).toHaveCSS("grid-template-columns", w === 390 ? /^(\d+(\.\d+)?px)$/ : /^(\d+(\.\d+)?px) (\d+(\.\d+)?px)$/);
    await expectChartPlacement(page, w);
    await expectDateAxes(page);
    await expect(page.locator('.ma-home [aria-busy="true"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await captureHome(page, `admin-home-status-${w}`, "CS");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();

  for (const [id, href] of [["sellers", "/admin/partners"], ["live", "/admin/ops/live"], ["orders", "/admin/ops/access"], ["subscription", "/admin/billing/subscriptions"], ["grace", "/admin/billing/subscriptions"]]) {
    const link = page.getByTestId(`home-kpi-${id}`).getByRole("heading").getByRole("link");
    await expect(link).toHaveAttribute("href", href);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await page.goto("/admin");
    await expect(page.getByTestId("today-tasks")).toBeVisible();
    await openStatus(page);
  }
  await expect(page.getByTestId("home-kpi-revenue").getByRole("link")).toHaveCount(0);

  await page.goto("/admin");
  await tasks.getByTestId("today-task-signupPending").click();
  await expect(page).toHaveURL(/\/admin\/partners\/applications/);
  await expect(page.getByRole("link", { name: pendingShop })).toBeVisible();
});

test("기간별 현황: 상위 5 파트너스에 결제된 쇼핑몰이 오르고, 기간 버튼이 바뀐다", async ({ page }) => {
  await login(page);
  await openStatus(page);
  await expect(page.getByRole("button", { name: "최근 30일" })).toHaveAttribute("aria-pressed", "true");
  const row = page.getByTestId("top-seller-row").filter({ hasText: topShop });
  await expect(row).toContainText("123,456원");
  await expect(page.getByTestId("stats-orders")).toContainText("결제 금액");
  await expect(page.getByTestId("stats-subscriptions")).toContainText("월별 받은 구독료");
  await expect(page.getByTestId("stats-order-series")).toContainText("결제된 주문");
  await expect(page.getByTestId("stats-growth")).toContainText("가입 신청");
  await expect(page.getByTestId("home-month-billing")).toContainText("청구 · 결제 내역");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const days of [7, 30, 90]) {
      const now = Date.now();
      const kst = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
      const from = kst(now - (days - 1) * 86_400_000);
      const to = kst(now);
      const isPeriodResponse = (path: string) => (response: Response) => {
        const url = new URL(response.url());
        return url.pathname === path && url.searchParams.get("from") === from && url.searchParams.get("to") === to && url.searchParams.get("unit") === "day";
      };
      const button = page.getByRole("button", { name: `최근 ${days}일`, exact: true });
      const [ordersResponse, growthResponse] = await Promise.all([
        page.waitForResponse(isPeriodResponse("/api/admin/stats/orders")),
        page.waitForResponse(isPeriodResponse("/api/admin/stats/growth")),
        button.click(),
      ]);
      expect(ordersResponse.status()).toBe(200);
      expect(growthResponse.status()).toBe(200);
      const [orders, growth] = await Promise.all([ordersResponse.json(), growthResponse.json()]);
      for (const data of [orders, growth]) {
        expect(data.range).toMatchObject({ from, to, unit: "day" });
        expect(data.series).toHaveLength(days);
      }
      // 기존 최대 8개 눈금에서 CSS가 남기는 첫 날짜와 끝 날짜를 응답 기간과 대조한다.
      const endpoints = (series: { bucket: string }[]) => {
        const sampled = series.filter((_, i) => i % Math.ceil(series.length / 8) === 0);
        return [sampled[0].bucket.replaceAll("-", "."), sampled.at(-1)!.bucket.replaceAll("-", ".")];
      };
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("top-seller-row").filter({ hasText: topShop })).toBeVisible();
      await expectDateAxes(page, { days, orders: endpoints(orders.series), growth: endpoints(growth.series) });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    }
  }
});

test("지연된 통계 조회는 갱신에 중복되지 않고 완료되며 기간 변경의 이전 응답을 버린다", async ({ page }) => {
  await page.clock.install();
  await login(page);
  const held: { url: string; release: () => void }[] = [];
  await page.route("**/api/admin/stats/orders**", async (route) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    held.push({ url: route.request().url(), release });
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await openStatus(page);
  await expect.poll(() => held.length).toBe(1);
  const refresh = page.getByRole("button", { name: "새로 고침", exact: true });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await page.clock.runFor(120_001);
  expect(held).toHaveLength(1);
  held[0].release();
  await expect(page.locator(".ma-home-line svg")).toBeVisible();

  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect.poll(() => held.length).toBe(2);
  await page.getByRole("button", { name: "최근 7일", exact: true }).click();
  await expect.poll(() => held.length).toBe(3);
  expect(held[2].url).not.toBe(held[1].url);
  const oldResponse = page.waitForResponse((response) => response.url() === held[1].url);
  held[1].release();
  await oldResponse;
  await expect(page.locator(".ma-home-line svg")).toHaveCount(0);
  held[2].release();
  await expect(page.locator(".ma-home-line svg")).toBeVisible();
  await expect(page.getByRole("button", { name: "최근 7일", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(held).toHaveLength(3);
});

test("지연된 홈 요약과 인프라 조회도 주기·수동 갱신에 중복되지 않고 완료된다", async ({ page }) => {
  await page.clock.install();
  const held: { path: string; release: () => void }[] = [];
  for (const path of ["/api/admin/dashboard", "/api/admin/infra/summary"]) {
    await page.route(`**${path}`, async (route) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      held.push({ path, release });
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
  }
  await login(page, suEmail);
  await expect.poll(() => held.length).toBe(2);
  await page.clock.runFor(120_001);
  expect(held.map((r) => r.path).sort()).toEqual(["/api/admin/dashboard", "/api/admin/infra/summary"]);
  held.slice().forEach((r) => r.release());
  await expect(page.getByTestId("dash-sellers-total")).toBeVisible();
  await expect(page.getByTestId("infra-card-cost")).toBeVisible();

  const refresh = page.getByRole("button", { name: "새로 고침", exact: true });
  await refresh.click();
  await expect.poll(() => held.length).toBe(4);
  await page.clock.runFor(120_001);
  expect(held).toHaveLength(4);
  held.slice(2).forEach((r) => r.release());
  await expect(refresh).toBeEnabled();
  await expect(page.getByTestId("dash-sellers-total")).toBeVisible();
  await expect(page.getByTestId("infra-card-cost")).toBeVisible();
});

test("한 통계가 실패해도 오늘 처리할 일과 나머지 통계는 그대로 보이고, 다시 시도하면 불러온다", async ({ page }) => {
  let fail = true;
  await page.route("**/api/admin/stats/orders**", (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' }) : route.continue()));
  await login(page);
  await expect(page.getByTestId("home-revenue-orders")).toContainText("불러오지 못했습니다");
  await expect(page.getByTestId("today-task-signupPending")).toBeVisible();
  await openStatus(page);
  await expect(page.getByTestId("stats-orders")).toContainText("불러오지 못했습니다");
  await expect(page.getByTestId("stats-top")).toContainText(topShop);
  fail = false;
  await page.getByTestId("stats-orders").getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("stats-orders")).toContainText("결제 금액");
});

test("빈 파트너스 안내와 요약 오류는 데모 수치 없이 독립적으로 보인다", async ({ page }) => {
  let fail = false;
  await page.route("**/api/admin/dashboard", (route) => route.fulfill({
    status: fail ? 500 : 200,
    contentType: "application/json",
    body: fail ? '{"error":"x"}' : JSON.stringify({ at: new Date().toISOString(), sellers: { total: 0, PENDING: 0, ACTIVE: 0, SUSPENDED: 0, REJECTED: 0, CLOSED: 0 }, liveBroadcasts: 0, ordersToday: { created: 0, paid: 0, paidAmount: 0 }, subscriptions: { trial: 0, paid: 0, charging: 0, grace: 0, expired: 0 } }),
  }));
  await login(page);
  await expect(page.getByTestId("dash-sellers-total")).toHaveText("0곳");
  await openStatus(page);
  await expect(page.getByTestId("home-kpi-sellers")).toContainText("아직 파트너스가 없습니다");
  await expect(page.getByTestId("stats-top")).toContainText(topShop);
  fail = true;
  await page.getByRole("button", { name: "새로 고침", exact: true }).click();
  await expect(page.getByTestId("home-kpi-sellers")).toContainText("불러오지 못했습니다");
  await expect(page.getByTestId("stats-top")).toContainText(topShop);
  await expect(page.getByTestId("home-kpi-sellers")).not.toContainText("184");
});

test("최고관리자: 오늘 처리할 일 아래에 인프라 · 비용 요약 카드가 보이고 누르면 인프라 · 비용 화면으로 간다", async ({ page }) => {
  await login(page, suEmail);
  const card = page.getByTestId("infra-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("infra-card-cost")).toBeVisible();
  await expect(card.getByTestId("infra-card-warnings")).toBeVisible();
  await expect(page.getByRole("link", { name: "DB 응답 · 연결", exact: true })).toHaveAttribute("href", "/admin/home/status");
  await expect(page.getByRole("link", { name: "최근 관리자 활동 · 로그 추적", exact: true })).toHaveAttribute("href", "/admin/logs");
  const above = await page.getByTestId("today-tasks").boundingBox();
  const at = await card.boundingBox();
  expect(at!.y).toBeGreaterThan(above!.y); // 「오늘 처리할 일」 바로 아래
  await expect(page.locator('.ma-home [aria-busy="true"]')).toHaveCount(0);
  await captureHome(page, "admin-home-infra-1440", "SUPER_ADMIN");
  for (const w of [1024, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.reload();
    await expect(page.getByTestId("infra-card")).toBeVisible();
    await expect(page.getByTestId("infra-card-cost")).toBeVisible();
    await expect(page.locator('.ma-home [aria-busy="true"]')).toHaveCount(0);
    await captureHome(page, `admin-home-infra-${w}`, "SUPER_ADMIN");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await openStatus(page);
  await expect(page.getByTestId("home-db-metrics")).toContainText("DB 연결");
  await expect(page.getByTestId("home-admin-activity")).toContainText("로그 추적 전체");
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.ma-home [aria-busy="true"]')).toHaveCount(0);
    await captureHome(page, `admin-home-status-super-${width}`, "SUPER_ADMIN");
  }
  await card.getByRole("link").click();
  await expect(page).toHaveURL(/\/admin\/ops\/infra$/);
});
