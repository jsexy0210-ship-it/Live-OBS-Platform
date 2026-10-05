import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, resetCartInDb } from "./cartDb";

// SH-021 주문 내역(운영 빌드 + 데모 시드). 데모 구매자(demo-buyer1@example.com)로 주문을 하나 만들어 목록에서 확인하고 끝에 지운다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const since = new Date(Date.now() - 60_000);

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
async function makeOrder(page: Page, baseURL: string) {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  const pid = list.products.find((p) => p.name === "탑로더 25장")!.id;
  const product = (await (await page.request.get(`/api/shop/${SLUG}/products/${pid}`)).json()) as { product: { options: { id: string }[] } };
  const consent = (await (await page.request.get(`/api/shop/${SLUG}/order-consent`)).json()) as { consents: { version: string }[] };
  const r = await page.request.post(`/api/shop/${SLUG}/orders`, {
    headers: { origin: baseURL },
    data: {
      items: [{ optionId: product.product.options[0].id, quantity: 2 }],
      consent: { agreed: true, noticeVersion: consent.consents[0].version },
      shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12" },
      saveAddress: false,
    },
  });
  expect(r.ok()).toBe(true);
  const { orderId } = (await r.json()) as { orderId: string };
  const o = (await (await page.request.get(`/api/shop/${SLUG}/orders/${orderId}`)).json()) as { orderNo: number };
  return { orderId, orderNo: o.orderNo };
}

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  await deleteBuyerOrdersSince(SLUG, LOGIN, since);
  await resetCartInDb(SLUG, LOGIN, []);
});

test("비회원: 로그인 안내", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/orders`);
  await expect(page.getByText("로그인하면 주문 내역을 볼 수 있어요.")).toBeVisible();
  await expect(page.getByRole("link", { name: "로그인", exact: true }).last()).toHaveAttribute("href", /\/login\?next=/);
});

test("PC: 주문 내역 표(열 제목 가운데·값 왼쪽)·상태 탭·결제하기 → 주문 상세", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, baseURL!);
  const { orderId, orderNo } = await makeOrder(page, baseURL!);
  await page.goto(`/shop/${SLUG}/orders`);
  await expect(page.getByRole("heading", { name: "주문 내역", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "내 정보 메뉴" }).getByRole("link", { name: "주문 내역" })).toHaveAttribute("aria-current", "page");
  const table = page.getByRole("table", { name: "주문 내역" });
  await expect(table.locator("thead th")).toHaveText(["주문일 · 번호", "상품 정보", "상태", "관리"]);
  expect(await table.locator("th").first().evaluate((el) => getComputedStyle(el).textAlign)).toBe("center"); // 열 제목은 가운데
  const row = table.locator("tbody tr", { has: page.getByRole("link", { name: String(orderNo), exact: true }) });
  expect(await row.locator("td").nth(1).evaluate((el) => getComputedStyle(el).textAlign)).toBe("left"); // 값은 왼쪽
  await expect(row).toContainText("탑로더 25장");
  await expect(row).toContainText("1팩 × 2");
  await expect(row).toContainText("결제 대기");
  await page.screenshot({ path: "tests/e2e/screenshots/SH-021-orders-1440.png" });
  // 탭: 결제 대기에는 있고 취소 · 환불에는 없다
  await page.getByRole("tab", { name: /^결제 대기/ }).click();
  await expect(table.getByRole("link", { name: String(orderNo), exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^취소 · 환불/ }).click();
  await expect(page.getByRole("link", { name: String(orderNo), exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: /^결제 대기/ }).click();
  await row.getByRole("link", { name: "결제하기" }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
  await expect(page.getByRole("region", { name: "결제", exact: true })).toBeVisible();
});

test("휴대폰 390: 주문 내역 가로 스크롤 없음", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, baseURL!);
  await makeOrder(page, baseURL!);
  await page.goto(`/shop/${SLUG}/orders`);
  await expect(page.getByRole("table", { name: "주문 내역" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-021-orders-390.png", fullPage: true });
});
