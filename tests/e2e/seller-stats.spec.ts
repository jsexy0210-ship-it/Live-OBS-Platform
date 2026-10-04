import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 파트너스 통계(주문·매출). dev-seed의 데모 주문(최근 약 8일, 결제 대기·완료·환불·취소)으로 확인한다.
// 화면 숫자는 같은 요청의 API 응답과 맞춰 본다(집계 정확성은 통합 시험 tests/integration/stats.test.ts가 확인).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function login(page: Page, email: string, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${next.replace(/\//g, "\\/")}$`));
}

const statsResponse = (page: Page, kind: string, has?: string) =>
  page.waitForResponse((r) => r.url().includes(`/api/seller/stats/${kind}?`) && (!has || r.url().includes(has)));
const kpi = (page: Page, label: string) => page.getByTestId("stats-kpi").filter({ has: page.getByText(label, { exact: true }) }).locator(".v");
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

test("주문 통계: 기간·단위를 바꾸면 다시 집계하고, 화면 숫자가 API와 같고, CSV로 내려받는다", async ({ page }) => {
  const first = statsResponse(page, "orders");
  await login(page, "demo-owner@example.com", "/seller/stats/orders");
  await first;
  await expect(page.getByRole("heading", { name: "통계 · 주문" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "통계", exact: true })).toHaveAttribute("href", "/seller/stats");

  const r30 = statsResponse(page, "orders");
  await page.getByRole("button", { name: "30일", exact: true }).click();
  const body = await (await r30).json();
  expect(body.current.orders).toBeGreaterThan(0);
  await expect(kpi(page, "주문 수")).toHaveText(`${body.current.orders.toLocaleString("ko-KR")}건`);
  await expect(kpi(page, "결제액")).toHaveText(won(body.current.revenue));
  await expect(kpi(page, "순매출")).toHaveText(won(body.current.netRevenue));
  await expect(page.getByTestId("stats-table").locator("tbody tr")).toHaveCount(30);
  await shot(page, "stats-orders");

  const week = statsResponse(page, "orders", "unit=week");
  await page.getByRole("group", { name: "묶음 단위" }).getByRole("button", { name: "주" }).click();
  const w = await (await week).json();
  await expect(page.getByTestId("stats-table").locator("tbody tr")).toHaveCount(w.series.length);
  // 주 단위로 묶어도 기간 합계는 같다
  expect(w.current).toEqual(body.current);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "엑셀 내려받기" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^order-stats_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, "utf8");
  expect(csv.startsWith("﻿기간,주문 수,결제 주문,결제액,취소,환불,환불액,순매출")).toBe(true);
  expect(csv.trim().split("\r\n")).toHaveLength(w.series.length + 1);
});

test("직접 선택: 1년을 넘는 기간은 막고, 맞는 기간은 그 기간으로 집계한다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/stats/orders");
  await page.getByLabel("시작일").fill("2025-01-01");
  await page.getByLabel("종료일").fill("2026-01-02");
  await page.getByRole("button", { name: "조회" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "직접 입력은" })).toHaveText("직접 입력은 최대 12개월까지 가능합니다");
  const r = statsResponse(page, "orders", "from=2020-01-01");
  await page.getByLabel("시작일").fill("2020-01-01");
  await page.getByLabel("종료일").fill("2020-01-31");
  await page.getByRole("button", { name: "조회" }).click();
  expect((await r).status()).toBe(200);
  await expect(page.getByText("선택한 기간에 주문이 없습니다")).toBeVisible();
  await shot(page, "stats-orders-empty");
  // 이번 달: 그달 1일(KST)부터 오늘까지
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const month = statsResponse(page, "orders", `from=${today.slice(0, 8)}01&to=${today}`);
  await page.getByRole("button", { name: "이번 달" }).click();
  expect((await month).status()).toBe(200);
});

test("매출 통계: 매출 구성·결제 수단별을 API 값으로 보여 준다", async ({ page }) => {
  const first = statsResponse(page, "sales");
  await login(page, "demo-owner@example.com", "/seller/stats/sales");
  await first;
  const r30 = statsResponse(page, "sales");
  await page.getByRole("button", { name: "30일", exact: true }).click();
  const body = await (await r30).json();
  await expect(kpi(page, "결제액")).toHaveText(won(body.current.paid));
  await expect(kpi(page, "순매출")).toHaveText(won(body.current.net));
  await expect(page.getByTestId("stats-methods").locator("tbody tr")).toHaveCount(body.byMethod.length);
  await expect(page.getByTestId("stats-breakdown")).toContainText(won(body.current.gross));
  await shot(page, "stats-sales");
});

test("통계 권한이 없는 직원은 메뉴가 없고, 주소로 들어와도 권한 안내를 본다", async ({ page }) => {
  await login(page, "demo-viewer@example.com", "/seller/orders");
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "통계", exact: true })).toHaveCount(0);
  const r = statsResponse(page, "orders");
  await page.goto("/seller/stats/orders");
  expect((await r).status()).toBe(403);
  await expect(page.getByText("통계 조회 권한이 필요합니다")).toBeVisible();
  await shot(page, "stats-forbidden");
});

test("상품 통계: 상위 상품·안 팔린 상품을 API 값으로 보여 준다", async ({ page }) => {
  const first = statsResponse(page, "products");
  await login(page, "demo-owner@example.com", "/seller/stats/products");
  await first;
  const r30 = statsResponse(page, "products");
  await page.getByRole("button", { name: "30일", exact: true }).click();
  const body = await (await r30).json();
  await expect(kpi(page, "상품 매출")).toHaveText(won(body.current.revenue));
  if (body.top.length > 0) {
    await expect(page.getByTestId("stats-top").locator("tbody tr")).toHaveCount(body.top.length);
    await expect(page.getByTestId("stats-top").locator("tbody tr").first()).toContainText(body.top[0].name);
  }
  await expect(page.getByTestId("stats-unsold").locator("tbody tr")).toHaveCount(body.unsold.length);
  // 상품·방송 통계는 기간 합계만 보여 묶음 단위가 없다
  await expect(page.getByRole("group", { name: "묶음 단위" })).toHaveCount(0);
  await shot(page, "stats-products");
});

test("회원 통계: 신규 가입·구매 회원·재구매율을 API 값으로 보여 준다", async ({ page }) => {
  const first = statsResponse(page, "members");
  await login(page, "demo-owner@example.com", "/seller/stats/members");
  await first;
  const r30 = statsResponse(page, "members");
  await page.getByRole("button", { name: "30일", exact: true }).click();
  const body = await (await r30).json();
  await expect(kpi(page, "신규 가입")).toHaveText(`${body.current.signups.toLocaleString("ko-KR")}명`);
  await expect(kpi(page, "구매 회원")).toHaveText(`${body.current.buyers.toLocaleString("ko-KR")}명`);
  await expect(page.getByTestId("stats-table").locator("tbody tr")).toHaveCount(30);
  await shot(page, "stats-members");
});

test("방송 통계: 방송이 없으면 빈 상태를, 탭으로 다른 통계로 옮겨 간다", async ({ page }) => {
  const first = statsResponse(page, "broadcasts");
  await login(page, "demo-owner@example.com", "/seller/stats/broadcasts");
  const body = await (await first).json();
  expect(body.unavailable).toEqual(["viewers", "conversion"]);
  if (body.total.broadcasts === 0) await expect(page.getByText("선택한 기간에 진행한 방송이 없습니다")).toBeVisible();
  else {
    // 방송마다 방송 매출 줄 + 방송 시간 일반 주문 줄
    await expect(page.getByTestId("stats-broadcasts").locator("tbody tr")).toHaveCount(body.broadcasts.length * 2);
    await expect(page.getByTestId("stats-broadcast-general")).toHaveCount(body.broadcasts.length);
  }
  await shot(page, "stats-broadcasts");
  await page.getByRole("navigation", { name: "통계 종류" }).getByRole("link", { name: "매출" }).click();
  await expect(page).toHaveURL(/\/seller\/stats\/sales$/);
});

test("통계 요약(SA-056): 요약 지표·방송 내역·상품 상위·회원 표를 API 값으로 보여 주고, 비교를 끄면 직전 기간 줄이 사라지고, 한 파일로 내려받는다", async ({ page }) => {
  const first = statsResponse(page, "overview");
  await login(page, "demo-owner@example.com", "/seller/stats");
  await first;
  await expect(page.getByRole("heading", { name: "통계 · 요약" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "통계 종류" }).getByRole("link", { name: "요약" })).toHaveClass(/on/);
  const r30 = statsResponse(page, "overview");
  await page.getByRole("button", { name: "30일", exact: true }).click();
  const body = await (await r30).json();
  await expect(kpi(page, "매출 (결제 기준)")).toHaveText(won(body.summary.current.revenue));
  await expect(kpi(page, "주문")).toHaveText(`${body.summary.current.orders.toLocaleString("ko-KR")}건`);
  await expect(kpi(page, "방문자")).toHaveText("준비 중");
  // 방송 매출 · 방송 시간 일반 주문 · 방송 외 주문 · 합계(= 요약 매출)
  const bt = page.getByTestId("overview-broadcasts");
  await expect(bt.locator("tbody tr")).toHaveCount(4);
  await expect(bt.locator("tbody tr.total")).toContainText(won(body.summary.current.revenue));
  await expect(page.getByTestId("overview-rewards")).toContainText(won(body.rewards.earned));
  await expect(page.getByTestId("overview-rewards")).toContainText("쿠폰 사용");
  // 비교(기본 켬): 비교하는 칸 5개(매출·주문·주문당 평균·취소·환불·신규 회원)에 직전 기간 줄이 있고, 끄면 없다
  const cmpLines = page.getByTestId("stats-kpi").locator(".d").filter({ hasText: "직전 기간" });
  await expect(cmpLines).toHaveCount(5);
  await page.getByLabel("직전 기간과 비교").uncheck();
  await expect(cmpLines).toHaveCount(0);
  await page.getByLabel("직전 기간과 비교").check();
  if (body.products.top.length > 0) await expect(page.getByTestId("overview-products").locator("tbody tr").first()).toContainText(body.products.top[0].name);
  await shot(page, "stats-overview");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "엑셀 내려받기" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^stats-summary_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, "utf8");
  for (const h of ["일별 매출", "방송 내역", "방송 외 주문", "상품 상위"]) expect(csv).toContain(h);
});
