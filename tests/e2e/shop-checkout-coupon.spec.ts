import { expect, test } from "@playwright/test";
import { resetCartInDb } from "./cartDb";
import { clearCouponsInDb, grantAmountCouponInDb } from "./couponDb";

// 주문서 쿠폰 적용(서버 견적 POST /orders/quote): 쿠폰을 고르면 할인이 요약에 반영되고, 해제하면 돌아온다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearCouponsInDb(SLUG);
  await grantAmountCouponInDb(SLUG, LOGIN, "주문서 시험 쿠폰", 3000);
});
test.afterAll(async () => {
  await clearCouponsInDb(SLUG);
  await resetCartInDb(SLUG, LOGIN, []);
});

test("쿠폰을 고르면 쿠폰 할인이 요약에 보이고 최종 결제 금액에서 빠진다", async ({ page, baseURL }) => {
  await resetCartInDb(SLUG, LOGIN, [{ productName: "스타라이트 부스터 박스", quantity: 1 }]);
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  await page.goto(`/shop/${SLUG}/cart`);
  await page.getByRole("link", { name: /주문하기$/ }).click();
  await expect(page.getByRole("heading", { name: "주문서", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: /주문 상품/ })).toBeVisible();
  if (await page.getByRole("radio", { name: /새 배송지 입력/ }).count()) await page.getByRole("radio", { name: /새 배송지 입력/ }).check();
  await page.getByLabel("우편번호").fill("06234");
  await page.getByLabel("주소", { exact: true }).fill("서울 강남구 테스트로 12");
  const sum = page.getByRole("complementary", { name: "주문 금액" });
  const total = sum.locator(".cart-row", { hasText: "최종 결제 금액" }).locator("b");
  await expect(total).toContainText("원");
  const before = Number((await total.innerText()).replace(/[^0-9]/g, ""));
  await expect(sum.getByText("쿠폰 할인")).toHaveCount(0);

  const opt = page.locator("#co-coupon-sel option", { hasText: "주문서 시험 쿠폰" });
  await page.locator("#co-coupon-sel").selectOption(await opt.getAttribute("value"));
  await expect(sum.locator(".cart-row", { hasText: "쿠폰 할인" })).toContainText("−3,000원");
  await expect(total).toHaveText(`${(before - 3000).toLocaleString("ko-KR")}원`);

  await page.locator("#co-coupon-sel").selectOption("");
  await expect(sum.getByText("쿠폰 할인")).toHaveCount(0);
  await expect(total).toHaveText(`${before.toLocaleString("ko-KR")}원`);
});
