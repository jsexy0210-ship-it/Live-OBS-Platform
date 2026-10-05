import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, resetCartInDb } from "./cartDb";

// SH-007 결제(운영 빌드 + 데모 시드). 결제 서버는 호출만 막아(route) 화면 약속을 확인한다. 만든 주문은 끝에 지운다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const since = new Date(Date.now() - 60_000);

async function orderPage(page: Page, baseURL: string, qs = "?done=1") {
  const login = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(login.status()).toBe(200);
  const detail = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  const pid = detail.products.find((p) => p.name === "탑로더 25장")!.id;
  const product = (await (await page.request.get(`/api/shop/${SLUG}/products/${pid}`)).json()) as { product: { options: { id: string }[] } };
  const consent = (await (await page.request.get(`/api/shop/${SLUG}/order-consent`)).json()) as { consents: { version: string }[] };
  const r = await page.request.post(`/api/shop/${SLUG}/orders`, {
    headers: { origin: baseURL },
    data: {
      items: [{ optionId: product.product.options[0].id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: consent.consents[0].version },
      shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12" },
      saveAddress: false,
    },
  });
  expect(r.ok()).toBe(true);
  const { orderId } = (await r.json()) as { orderId: string };
  await page.goto(`/shop/${SLUG}/orders/${orderId}${qs}`);
  return orderId;
}

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  await deleteBuyerOrdersSince(SLUG, LOGIN, since);
  await resetCartInDb(SLUG, LOGIN, []);
});

test("결제 대기 주문: 카드가 기본, 금액 확인 버튼, 결제 준비 중 안내·무통장 입금 안내·결제 결과 안내", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const orderId = await orderPage(page, baseURL!);
  const box = page.getByRole("region", { name: "결제", exact: true });
  await expect(box.getByRole("radio", { name: "카드 결제" })).toBeChecked(); // 기본 수단
  await expect(box.getByText(/결제 기한 .+까지예요/)).toBeVisible();
  const amount = await page.locator(".cart-row b").last().innerText(); // 결제 금액
  await expect(box.getByRole("button", { name: `${amount} 결제하기` })).toBeVisible(); // 금액은 읽기 전용, 누르기 전에 보인다
  await page.screenshot({ path: "tests/e2e/screenshots/SH-007-pay-1440.png", fullPage: true });

  // 카드: 결제 준비 중이면 안내가 그대로 보인다
  await page.route("**/api/shop/*/payments", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "payment_not_ready", message: "결제 준비 중이에요. 잠시 후 다시 시도해 주세요" }) }));
  await box.getByRole("button", { name: /결제하기$/ }).click();
  await expect(box.getByRole("alert")).toContainText("결제 준비 중이에요");

  // 무통장: 계좌 안내
  await page.route("**/api/shop/*/payments/bank-transfer", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ orderId, amount: 6000, bankName: "시험은행", accountNumber: "123-456-789012", accountHolder: "별빛", paymentDueAt: null }) }),
  );
  await box.getByRole("radio", { name: "무통장 입금" }).check();
  await box.getByRole("button", { name: "무통장 입금 안내 받기" }).click();
  const info = box.getByRole("group", { name: "입금 계좌 안내" }).or(box.locator("dl.od-dl"));
  await expect(info).toContainText("시험은행");
  await expect(info).toContainText("123-456-789012");

  // 결제 창이 끝난 뒤 서버가 보내는 주소는 주문 상세로 이어지고 결과 안내가 나온다
  await page.goto(`/shop/${SLUG}/orders?orderId=${orderId}&payment=failed`);
  await expect(page).toHaveURL(new RegExp(`/orders/${orderId}\\?payment=failed$`));
  await expect(page.getByRole("status")).toContainText("결제하지 못했어요");
  await page.goto(`/shop/${SLUG}/orders?orderId=${orderId}&payment=pending`);
  await expect(page.getByRole("status")).toContainText("결제를 확인하고 있어요");
});

test("휴대폰 390: 결제 영역도 가로 스크롤 없음", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await orderPage(page, baseURL!);
  await expect(page.getByRole("region", { name: "결제", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
