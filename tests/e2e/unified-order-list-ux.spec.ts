import { expect, test, type Page } from "@playwright/test";

test.use({ launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH } });

// Browser fixtures verify rendered UX and request contracts only. They do not
// authenticate against a DB or prove real payment, refund, or deposit processing.
const firstOrderId = "00000000-0000-4000-8000-000000000001";
const order = (n: number, status = "PAID", shipped = false) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, orderNo: n,
  orderNoLabel: `20261006-${String(n).padStart(4, "0")}`, status,
  totalAmount: 12000, refundedAmount: n === 3 ? 1000 : 0,
  createdAt: "2026-10-06T01:00:00Z", paymentDueAt: "2026-10-06T03:00:00Z",
  buyer: { broadcastNickname: `시험 구매자 ${n}` }, itemSummary: { firstProductName: "검증용 상품", otherCount: 0 },
  shipped, refundable: status === "PAID", paymentMethod: status === "PENDING_PAYMENT" ? "BANK_TRANSFER" : "CARD",
  shipment: { state: shipped ? "in_transit" : "none", courier: null, trackingNumber: null, deliveredAt: null },
  refundRequest: { pendingCount: n === 3 ? 1 : 0 },
});
const deposit = (n: number) => ({ orderId: order(n).id, orderNo: n, amount: 12000,
  nickname: `시험 구매자 ${n}`, depositorName: `시험 입금자 ${n}`, paymentMethod: "BANK_TRANSFER",
  paymentDueAt: "2026-10-06T03:00:00Z", createdAt: "2026-10-06T01:00:00Z" });

type Scenario = { status?: number; empty?: boolean; hold?: Promise<void>; requests?: URL[]; confirmations?: unknown[] };
async function fixtures(page: Page, scenario: Scenario = {}) {
  let confirmed: string[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname === "/api/seller/me") return json({ sellerId: "fixture", userId: "fixture", isOwner: true,
      permissions: ["ORDER_SHIPPING"], access: "paid", features: ["STORE_OPERATIONS", "OVERLAY"],
      shop: { name: "목록 검증", slug: "fixture" }, user: { name: "검증", email: "fixture@example.com" }, trialEndsAt: null });
    if (url.pathname === "/api/seller/queue/version") return json({ version: 7 });
    if (url.pathname === "/api/seller/payments/deposits/confirm") {
      const body = request.postDataJSON() as { orderIds: string[]; expectedVersion: number };
      scenario.confirmations?.push(body);
      confirmed = [...confirmed, ...body.orderIds];
      return json({ results: body.orderIds.map(orderId => ({ orderId, result: "paid" })) });
    }
    if (["/api/seller/orders", "/api/seller/payments/deposits"].includes(url.pathname)) {
      scenario.requests?.push(url);
      if (scenario.hold) await scenario.hold;
      if (scenario.status) return json({ error: scenario.status === 403 ? "forbidden" : "fixture_error" }, scenario.status);
      if (url.pathname === "/api/seller/orders") {
        let rows = scenario.empty ? [] : [order(1, "PENDING_PAYMENT"), order(2), order(3, "PAID", true)];
        if (url.searchParams.get("cursor")) return json({ orders: [order(4)], nextCursor: null });
        if (url.searchParams.get("status")) rows = rows.filter(row => url.searchParams.getAll("status").includes(row.status));
        if (url.searchParams.get("shipped")) rows = rows.filter(row => String(row.shipped) === url.searchParams.get("shipped"));
        if (url.searchParams.get("q")) rows = rows.filter(row => row.buyer.broadcastNickname.includes(url.searchParams.get("q")!));
        return json({ orders: rows, nextCursor: rows.length ? "fixture-cursor" : null });
      }
      const rows = scenario.empty ? [] : [deposit(1), deposit(2), deposit(3)].filter(row => !confirmed.includes(row.orderId));
      return json({ deposits: url.searchParams.has("offset") ? [deposit(4)] : rows, total: scenario.empty ? 0 : 4 - confirmed.length });
    }
    return json({});
  });
}

async function structure(page: Page) {
  await expect(page.locator(".au-ph-description")).toBeVisible();
  await expect(page.locator(".au-lh-total")).toBeVisible();
  await expect(page.locator(".ord-data-grid")).toBeVisible();
  expect(await page.locator(".ord-data-grid").evaluate(el => !!el.querySelector(".au-lh, .ord-filters, .ord-more, .dep-more"))).toBe(false);
  expect(await page.locator(".main .card").count()).toBe(0);
  const metrics = await page.locator(".au-lh").evaluate(el => {
    const count = el.querySelector(".au-lh-total")!.getBoundingClientRect();
    const actions = el.querySelector(".au-lh-act")!.getBoundingClientRect();
    const head = el.getBoundingClientRect();
    return { countLeft: count.left, headLeft: head.left, actionsRight: actions.right, headRight: head.right };
  });
  expect(metrics.countLeft - metrics.headLeft).toBeLessThanOrEqual(1);
  expect(metrics.headRight - metrics.actionsRight).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [1440, 1024, 390]) {
  test(`fixture SA-021 구조·필터·cursor·관리 링크 ${width}`, async ({ page }, testInfo) => {
    const requests: URL[] = [];
    await page.setViewportSize({ width, height: 900 });
    await fixtures(page, { requests });
    await page.goto("/seller/orders");
    await expect(page.getByTestId("order-row")).toHaveCount(3);
    await structure(page);
    await expect(page.locator(".au-lh-total")).toHaveText("불러온 3건");
    await expect(page.getByText(/건 넘게/)).toHaveCount(0);
    await expect(page.getByTestId("order-row").first().getByRole("link", { name: "입금 확인", exact: true })).toHaveAttribute("href", "/seller/orders/deposits");
    await expect(page.getByTestId("order-row").nth(1).getByRole("link", { name: "송장 입력" })).toHaveAttribute("href", "/seller/shipping");
    await expect(page.getByTestId("order-row").nth(2).getByRole("link", { name: "환불 처리" })).toHaveAttribute("href", "/seller/orders/refund-requests");
    await page.screenshot({ path: testInfo.outputPath(`SA-021-${width}.png`), fullPage: true });
    await testInfo.attach(`SA-021-${width}`, { path: testInfo.outputPath(`SA-021-${width}.png`), contentType: "image/png" });
    await page.getByRole("button", { name: "주문 더 불러오기" }).click();
    await expect(page.getByTestId("order-row")).toHaveCount(4);
    expect(requests.some(url => url.searchParams.get("cursor") === "fixture-cursor")).toBe(true);
    await expect(page.locator(".au-lh-total")).toHaveText("불러온 4건");
    await page.getByRole("group", { name: "주문 상태" }).getByRole("button", { name: "배송 준비 전", exact: true }).click();
    await expect(page.getByTestId("order-row")).toHaveCount(1);
    expect(requests.at(-1)?.searchParams.get("status")).toBe("PAID");
    expect(requests.at(-1)?.searchParams.get("shipped")).toBe("false");
    await page.getByRole("button", { name: "상세 검색 펼치기" }).click();
    await page.getByRole("button", { name: /상태: 완료/ }).click();
    const popup = page.getByRole("group", { name: "결제 상태" });
    await expect(popup).toBeVisible();
    const bounds = await popup.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`SA-021-filter-${width}.png`), fullPage: true });
    await popup.getByLabel("완료", { exact: true }).uncheck();
    await popup.getByLabel("결제 대기", { exact: true }).check();
    await popup.getByRole("button", { name: "이 상태로 보기" }).click();
    await expect(page).toHaveURL(/status=PENDING_PAYMENT/);
    await page.getByRole("button", { name: "필터 초기화", exact: true }).first().click();
    await expect(page.getByTestId("order-row")).toHaveCount(3);
    await expect(page.getByLabel("주문 검색")).toHaveAttribute("placeholder", "검색어 입력");
    await expect(page.getByLabel("주문 검색")).toHaveAttribute("title", "닉네임 · 주문번호로 검색");
    await page.getByLabel("주문 검색").fill("시험 구매자 2");
    await expect(page.getByTestId("order-row")).toHaveCount(1);
    await expect(page.getByTestId("order-row")).toContainText("시험 구매자 2");
    await page.reload();
    await expect(page.getByLabel("주문 검색")).toHaveValue("시험 구매자 2");
    await expect(page.getByTestId("order-row")).toHaveCount(1);
    if (width === 390) {
      const height = await page.getByRole("button", { name: "상세 검색 접기" }).evaluate(el => el.getBoundingClientRect().height);
      expect(height).toBeGreaterThanOrEqual(44);
    }
  });

  test(`fixture SA-026 구조·선택·확인 창·요청 계약 ${width}`, async ({ page }, testInfo) => {
    const confirmations: unknown[] = [];
    const requests: URL[] = [];
    await page.setViewportSize({ width, height: 900 });
    await fixtures(page, { confirmations, requests });
    await page.goto("/seller/orders/deposits");
    await expect(page.getByTestId("deposit-row")).toHaveCount(3);
    await structure(page);
    await expect(page.locator(".au-lh-total")).toHaveText("총 4건");
    const batch = page.getByRole("button", { name: /^선택 입금 확인/ });
    await expect(batch).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`SA-026-${width}.png`), fullPage: true });
    await testInfo.attach(`SA-026-${width}`, { path: testInfo.outputPath(`SA-026-${width}.png`), contentType: "image/png" });
    await page.getByRole("checkbox", { name: "시험 구매자 1 선택" }).check();
    await expect(batch).toHaveText("선택 입금 확인 (1)");
    await batch.click();
    const dialog = page.getByRole("dialog", { name: "입금을 확인하시겠습니까?" });
    await expect(dialog).toContainText("시험 구매자 1");
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    expect(confirmations).toHaveLength(0);
    await batch.click();
    await dialog.getByRole("button", { name: "입금 확인", exact: true }).click();
    await expect(page.getByTestId("deposit-row")).toHaveCount(2);
    expect(confirmations).toEqual([{ orderIds: [firstOrderId], expectedVersion: 7 }]);
    await page.getByRole("button", { name: "더 불러오기", exact: true }).click();
    await expect(page.getByTestId("deposit-row")).toHaveCount(3);
    expect(requests.some(url => url.searchParams.get("offset") === "2")).toBe(true);
    if (width === 390) {
      expect(await batch.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      const due = page.getByTestId("deposit-row").first().locator('[data-card="wide"]');
      expect(await due.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  });
}

for (const [path, emptyText, errorText] of [
  ["/seller/orders", "아직 주문이 없습니다", "주문을 불러오지 못했습니다"],
  ["/seller/orders/deposits", "입금 전 주문이 없습니다", "입금 대기 주문을 불러오지 못했습니다"],
]) {
  test(`fixture 로딩·0건·오류·권한 ${path}`, async ({ page }, testInfo) => {
    const capture = async (state: string) => {
      const image = testInfo.outputPath(`${path.endsWith("deposits") ? "SA-026" : "SA-021"}-${state}-390.png`);
      await page.screenshot({ path: image, fullPage: true });
      await testInfo.attach(state, { path: image, contentType: "image/png" });
    };
    await page.setViewportSize({ width: 390, height: 900 });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const scenario: Scenario = { hold };
    await fixtures(page, scenario);
    await page.goto(path);
    await expect(page.locator(".sk").first()).toBeVisible();
    await capture("loading");
    scenario.empty = true;
    release();
    await expect(page.getByText(emptyText, { exact: true })).toBeVisible();
    await expect(page.locator(".au-lh-total")).toHaveText(path.endsWith("deposits") ? "총 0건" : "불러온 0건");
    await capture("empty");
    scenario.status = 500;
    await page.reload();
    await expect(page.getByText(errorText, { exact: true })).toBeVisible();
    await capture("error");
    scenario.status = undefined;
    await page.getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(page.getByText(emptyText, { exact: true })).toBeVisible();
    scenario.status = 403;
    await page.reload();
    await expect(page.getByText("이 계정은 이 일을 할 수 없습니다", { exact: true })).toBeVisible();
    await capture("forbidden");
    if (path.endsWith("deposits")) {
      scenario.status = 402;
      await page.reload();
      await expect(page.getByText("이용 기간이 끝나 지금은 사용할 수 없습니다", { exact: true })).toBeVisible();
      await capture("locked");
    }
  });
}
