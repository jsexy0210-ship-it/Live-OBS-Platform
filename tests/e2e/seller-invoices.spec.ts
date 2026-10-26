import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-027 송장 발급 · SA-028 출력·추적(모의 발급): 발송 대기 주문 → 합배송·주소 확인 → 발급 → 출력 → 추적.
// dev-seed 데모 주문의 발송 대기 주문을 실행마다 발급한다(폐기용 DB). 발송 대기가 다 떨어지면 DB를 새로 만들고 dev-seed를 다시 돌린다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("대표자: 송장 발급 → 출력 안 한 송장 확인 → 추적 상세", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fshipping%2Finvoices");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/shipping\/invoices$/);
  // 실행마다 같은 출발점: 기본 택배사를 비워 둔다
  const putCourier = (c: string | null) =>
    page.evaluate(async (courier) => {
      const cur = (await (await fetch("/api/seller/shipping-policy")).json()).policy;
      return (await fetch("/api/seller/shipping-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...cur, defaultCourier: courier }) })).status;
    }, c);
  expect(await putCourier(null)).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "송장 발급" })).toBeVisible();
  const tabs = page.getByRole("navigation").filter({ hasText: "출력 · 추적" }).first();
  await expect(tabs.getByRole("link", { name: "송장 발급" })).toHaveAttribute("aria-current", /.+/);
  await expect(page.getByRole("list", { name: "송장 발급 단계" })).toContainText("2. 합배송 · 주소 확인");
  // 기본 택배사가 없으면 발급할 수 없다(배송 설정 안내) → 정한 뒤 다시 연다
  await expect(page.getByRole("link", { name: "배송 설정" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^송장 \d+개 발급$/ })).toBeDisabled();
  expect(await putCourier("HANJIN")).toBe(200);
  await page.reload();
  await expect(page.getByText("고른 주문")).toBeVisible();
  await expect(page.getByText("배송 접수 업체는 아직 정해지지 않아")).toBeVisible();
  await shot(page, "SA-027-invoices");

  const issueBtn = page.getByRole("button", { name: /^송장 \d+개 발급$/ });
  await expect(issueBtn).toBeEnabled();
  await issueBtn.click();
  await expect(page.getByText(/송장 \d+개를 발급했습니다 · 출력 전까지 집하되지 않습니다/).first()).toBeVisible();
  await shot(page, "SA-027-invoices-done");

  await page.goto("/seller/shipping/tracking");
  await expect(page.getByRole("heading", { level: 1, name: "송장 출력 · 추적" })).toBeVisible();
  await expect(page.getByText("모의 데이터입니다")).toBeVisible();
  await expect(page.getByRole("link", { name: /출력 안 한 송장 [1-9]\d*개 출력/ })).toBeVisible();
  await page.getByRole("link", { name: /^발급됨 \d+$/ }).click();
  await expect(page.getByText("아직 출력 안 함").first()).toBeVisible();
  await shot(page, "SA-028-tracking");
  // 한 송장을 출력(모의)하면 출력됨으로 옮겨 가고, 그 줄의 「추적」에서 이벤트가 보인다
  const printed = await page.evaluate(async () => {
    const list = (await (await fetch("/api/seller/invoices?status=ISSUED")).json()).invoices as { id: string }[];
    const r = await fetch("/api/seller/invoices/print", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "LABEL_100X150", invoiceIds: [list[0].id] }) });
    return r.status;
  });
  expect(printed).toBe(200);
  await page.reload();
  await page.getByRole("link", { name: /^출력됨 \d+$/ }).click();
  await expect(page.getByText("집하 전").first()).toBeVisible();
  await page.getByRole("button", { name: "추적" }).first().click();
  await expect(page.getByRole("cell", { name: "업체 연동 전 · 모의", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "발급", exact: true }).first()).toBeVisible();
  await shot(page, "SA-028-tracking-detail");
});

test("송장 목록은 변경하지 않고 실제 상세에서만 재발급·집하·선택 출력을 실행한다", async ({ page }) => {
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller$/);
  const id = "00000000-0000-4000-8000-0000000000a1";
  let status = "FAILED", pickupDelayed = false, readOnly = false, unprinted = 0;
  const writes: { path: string; body: unknown }[] = [];
  const invoice = () => ({ id, status, courierName: "한진택배", trackingNumber: status === "FAILED" ? null : "OWNED123456", issuing: false, failureCode: status === "FAILED" ? "provider_error" : null, pickupDelayed, lastEvent: null, issuedAt: null, printedAt: null, orderCount: 1, nickname: "송장 합성", events: [], recipient: null });
  await page.route("**/api/seller/me", async (route) => {
    const response = await route.fetch(), me = await response.json();
    await route.fulfill({ response, json: readOnly ? { ...me, isOwner: false, permissions: ["ORDER_SHIPPING"], readOnly: true } : me });
  });
  await page.route("**/api/seller/invoices**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      writes.push({ path, body: request.postData() ? request.postDataJSON() : null });
      if (path === `/api/seller/invoices/${id}/retry`) { status = "PRINTED"; pickupDelayed = true; return route.fulfill({ json: { result: { ok: true } } }); }
      if (path === `/api/seller/invoices/${id}/pickup-request`) { pickupDelayed = false; return route.fulfill({ json: { ok: true } }); }
      expect(path).toBe("/api/seller/invoices/print");
      return route.fulfill({ json: { printed: 1, labels: [{ invoiceId: id, courierName: "한진택배", trackingNumber: "OWNED123456", mock: true, orders: [{ orderNoLabel: "합성 주문", nickname: "송장 합성", itemSummary: { firstProductName: "합성 상품", otherCount: 0 } }], recipient: null }] } });
    }
    expect(request.method()).toBe("GET");
    if (path === `/api/seller/invoices/${id}`) return route.fulfill({ json: { invoice: invoice() } });
    expect(path).toBe("/api/seller/invoices");
    return route.fulfill({ json: { invoices: [invoice()], nextCursor: null, counts: { [status]: 1 }, total: 1, mock: true, unprinted } });
  });
  await page.goto("/seller/shipping/tracking?tab=all");
  const list = page.locator(".au-list-grid");
  await expect(list.getByRole("link", { name: "송장 업무 상세", exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: /다시 발급|집하 요청|출력/ })).toHaveCount(0);
  expect(writes).toEqual([]);
  await list.getByRole("link", { name: "송장 업무 상세", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/seller/shipping/tracking/${id}\\?`));
  await page.reload();
  const detail = page.getByRole("region", { name: "송장 업무 상세", exact: true });
  await detail.getByRole("button", { name: "다시 발급", exact: true }).click();
  await expect(detail.getByRole("button", { name: "집하 요청 다시 보내기", exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "집하 요청 다시 보내기", exact: true }).click();
  await expect(detail.getByRole("button", { name: "집하 요청 다시 보내기", exact: true })).toHaveCount(0);
  await detail.getByRole("combobox", { name: "출력 방식", exact: true }).selectOption("A4_2UP");
  const popupPromise = page.waitForEvent("popup");
  await detail.getByRole("button", { name: "송장 출력", exact: true }).click();
  const popup = await popupPromise;
  await expect(popup.locator("body")).toContainText("한진택배 OWNED123456");
  await expect(popup.locator("body")).toContainText("합성 상품");
  await popup.close();
  expect(writes).toEqual([{ path: `/api/seller/invoices/${id}/retry`, body: null }, { path: `/api/seller/invoices/${id}/pickup-request`, body: null }, { path: "/api/seller/invoices/print", body: { format: "A4_2UP", invoiceIds: [id] } }]);
  unprinted = 123;
  await page.goto("/seller/shipping/tracking/print?scope=unprinted&format=A4_2UP");
  await expect(detail).toContainText("출력 안 한 송장 123개 · 현재 미출력 송장을 한 번에 최대 100개 출력합니다.");
  const unprintedPopupPromise = page.waitForEvent("popup");
  await detail.getByRole("button", { name: "송장 출력", exact: true }).click();
  const unprintedPopup = await unprintedPopupPromise;
  await expect(unprintedPopup.locator("body")).toContainText("한진택배 OWNED123456");
  await unprintedPopup.close();
  expect(writes.at(-1)).toEqual({ path: "/api/seller/invoices/print", body: { format: "A4_2UP" } });
  readOnly = true;
  await page.reload();
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("button")).toHaveCount(0);
  await expect(detail.getByRole("combobox")).toHaveCount(0);
  expect(writes).toHaveLength(4);
});
