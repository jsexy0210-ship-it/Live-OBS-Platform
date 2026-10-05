import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, resetCartInDb } from "./cartDb";

// 보드 SH-022-IA 맞춤: 머리글(주문일 · 상태 · 주문번호 복사) → 주문 상품 → 결제 정보 → 배송 정보 → 목록.
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
      shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12", memo: "문 앞에 두세요" },
      saveAddress: false,
    },
  });
  expect(r.ok()).toBe(true);
  const { orderId } = (await r.json()) as { orderId: string };
  const o = (await (await page.request.get(`/api/shop/${SLUG}/orders/${orderId}`)).json()) as { orderNoLabel: string };
  return { orderId, label: o.orderNoLabel };
}

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  await deleteBuyerOrdersSince(SLUG, LOGIN, since);
  await resetCartInDb(SLUG, LOGIN, []);
});

test("주문 상세: 머리글(주문일·상태·주문번호 복사) → 상품 → 결제 정보 → 배송 정보 → 목록 순서", async ({ page, baseURL, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, baseURL!);
  const { orderId, label } = await makeOrder(page, baseURL!);
  await page.goto(`/shop/${SLUG}/orders/${orderId}`);
  const head = page.getByLabel("주문 요약");
  await expect(head).toContainText("주문");
  await expect(head).toContainText("결제 전");
  await expect(head).toContainText(label);
  await head.getByRole("button", { name: "복사" }).click();
  await expect(head.getByRole("status")).toHaveText("주문번호를 복사했어요");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(label);

  const names = await page.locator(".co-main > section h2").allInnerTexts();
  const order = ["주문 상품", "결제 정보", "배송 정보"];
  const idx = order.map((n) => names.findIndex((t) => t.startsWith(n)));
  expect(idx.every((i) => i >= 0)).toBe(true);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);

  const pay = page.getByRole("region", { name: "결제 정보" });
  await expect(pay).toContainText("쿠폰 할인");
  await expect(pay).toContainText("0원 · 안 썼어요");
  const ship = page.getByRole("region", { name: "배송 정보" });
  await expect(ship).toContainText("김별빛");
  await expect(ship).toContainText("문 앞에 두세요");
  await expect(page.getByRole("link", { name: "목록" })).toHaveAttribute("href", `/shop/${SLUG}/orders`);
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: "tests/e2e/screenshots/SH-022-detail-1440.png", fullPage: true });
});

test("휴대폰 390: 주문 상세 가로 스크롤 없음", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, baseURL!);
  const { orderId } = await makeOrder(page, baseURL!);
  await page.goto(`/shop/${SLUG}/orders/${orderId}`);
  await expect(page.getByLabel("주문 요약")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: "tests/e2e/screenshots/SH-022-detail-390.png", fullPage: true });
});
