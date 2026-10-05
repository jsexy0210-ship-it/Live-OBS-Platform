import { expect, test } from "@playwright/test";
import { deleteBuyerOrdersSince, resetCartInDb } from "./cartDb";

// 보드 SH-005-IA 맞춤: 영역 순서(닉네임 → 배송지 → 주문 상품 → 쿠폰 → 적립금 → 결제 수단), 배송 메모 고르기, 결제 수단을 주문서에서 골라 주문 상세로 이어 가기.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const STARTED = new Date();

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  await resetCartInDb(SLUG, LOGIN, []);
  await deleteBuyerOrdersSince(SLUG, LOGIN, STARTED);
});

test("영역 순서·배송 메모 고르기·결제 수단(무통장)을 고르고 주문하면 주문 상세에 그 수단이 골라져 있다", async ({ page, baseURL }) => {
  await resetCartInDb(SLUG, LOGIN, [{ productName: "탑로더 25장", quantity: 1 }]);
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  await page.goto(`/shop/${SLUG}/cart`);
  await page.getByRole("link", { name: /주문하기$/ }).click();
  await expect(page.getByRole("heading", { name: "주문서", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: /주문 상품/ })).toBeVisible();

  const heads = (await page.locator(".co-main h2").allInnerTexts()).map((t) => t.replace(/\s*\d+개$/, "").trim());
  const order = ["방송 닉네임", "배송지", "주문 상품", "쿠폰", "결제 수단"];
  const at = order.map((h) => heads.indexOf(h));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at); // 보드 순서 그대로

  if (await page.getByRole("radio", { name: /새 배송지 입력/ }).count()) await page.getByRole("radio", { name: /새 배송지 입력/ }).check();
  await page.getByLabel("받는 분").fill("김별빛");
  await page.getByLabel("연락처").fill("010-1234-5678");
  await page.getByLabel("우편번호").fill("06234");
  await page.getByLabel("주소", { exact: true }).fill("서울 강남구 테스트로 12");
  await page.getByLabel("배송 메모 고르기").selectOption("경비실에 맡겨 주세요");
  await expect(page.getByLabel("배송 메모", { exact: true })).toHaveValue("경비실에 맡겨 주세요");

  await page.getByRole("radio", { name: "무통장 입금" }).check();
  await page.getByRole("checkbox", { name: /\(필수\)/ }).check();
  await page.getByRole("button", { name: "주문하기" }).click();
  await expect(page).toHaveURL(/\/orders\/[^/?]+\?done=1&pay=bank$/);
  await expect(page.getByRole("radio", { name: /무통장 입금/ })).toBeChecked();
});
