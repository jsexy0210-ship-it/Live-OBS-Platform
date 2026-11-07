import { expect, test, type Page } from "@playwright/test";
import { cleanupProducts, RUN, track } from "./cleanup";
import { submitSellerLogin } from "./sellerLogin";

// SA-012 「방송 주문대기 대상」 · 「오픈 타이머」(상품 폼)와 대기 제외 주문의 「배송 준비」 조건(주문 목록 · 상세).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
test.afterAll(() => cleanupProducts(PASSWORD));

async function login(page: Page, next: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
}
const hdr = (page: Page) => ({ Origin: new URL(page.url()).origin });

test("상품 수정: 방송 주문대기 대상을 제외로, 오픈 타이머를 120초로 바꾸면 저장되고 다시 열어도 그대로이다", async ({ page }) => {
  await login(page, "/seller/products");
  await expect(page).toHaveURL(/\/seller\/products$/);
  const made = await page.request.post("/api/seller/products", {
    data: { name: track(`방송대기e2e ${RUN}`), price: 3000, status: "ON_SALE", options: [{ name: "기본", priceDelta: 0, stock: 5, sortOrder: 0 }] },
    headers: hdr(page),
  });
  expect(made.status()).toBe(201);
  const { id, queueEligible, openTimerSeconds } = (await made.json()) as { id: string; queueEligible: boolean; openTimerSeconds: number | null };
  expect(queueEligible).toBe(true);
  expect(openTimerSeconds).toBeNull();

  await page.goto(`/seller/products/${id}`);
  const target = page.getByRole("radiogroup", { name: "방송 주문대기 대상" });
  const timer = page.getByLabel("오픈 타이머", { exact: true });
  await expect(target.getByRole("radio", { name: "대상" })).toBeChecked();
  await expect(timer).toHaveValue("");
  await target.getByRole("radio", { name: "제외" }).check();
  await timer.selectOption("120");
  const patch = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/seller/products/${id}` && r.request().method() === "PATCH");
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  expect((await patch).status()).toBe(200);

  const saved = (await (await page.request.get(`/api/seller/products/${id}`)).json()) as { queueEligible: boolean; openTimerSeconds: number | null };
  expect(saved).toMatchObject({ queueEligible: false, openTimerSeconds: 120 });
  await page.goto(`/seller/products/${id}`);
  await expect(page.getByRole("radiogroup", { name: "방송 주문대기 대상" }).getByRole("radio", { name: "제외" })).toBeChecked();
  await expect(page.getByLabel("오픈 타이머", { exact: true })).toHaveValue("120");
});

test("대기 제외 주문(queueFree): 목록에서 「대기 제외」로 보이고 「배송 준비」를 바로 할 수 있다", async ({ page }) => {
  await login(page, "/seller/orders");
  await expect(page.getByTestId("order-row").first()).toBeVisible();
  // 실제 응답 한 줄을 대기 제외 주문(큐 항목 없음 · 모든 품목 제외)으로 바꿔 보여 준다
  await page.route(/\/api\/seller\/orders\?/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { orders: Record<string, unknown>[] };
    // 시험 DB에 남은 주문 상태와 상관없이 첫 줄을 결제 완료 · 미발송 · 대기 제외 주문으로 바꿔 보여 준다
    Object.assign(body.orders[0]!, { status: "PAID", queueState: null, queueFree: true, shippingPreparedAt: null, shipped: false, refundRequest: { pendingCount: 0 }, shipment: { state: "none", courier: null, trackingNumber: null, deliveredAt: null } });
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  const row = page.getByTestId("order-row").filter({ hasText: "대기 제외" }).first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("link", { name: "배송 준비", exact: true })).toHaveAttribute("href", /\/seller\/orders\/[0-9a-f-]{36}\?.*#order-preparation$/);
  await expect(row.getByRole("checkbox")).toBeEnabled();
});
