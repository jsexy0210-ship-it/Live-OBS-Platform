import { expect, test } from "@playwright/test";

// UX 감사 P1 구매자: UX-07 로그인 replace · UX-12 없는 상품 안내 · J-3 내 정보 허브
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

test("없는 상품 주소는 상품 단위 안내와 목록 링크를 보여 준다(404)", async ({ page }) => {
  const res = await page.goto(`/shop/${SLUG}/products/00000000-0000-0000-0000-000000000000`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "상품을 찾을 수 없어요" })).toBeVisible();
  await page.getByRole("link", { name: "상품 목록으로" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/products$`));
});

test("로그인 뒤 뒤로 가기로 로그인 화면에 돌아오지 않고, 로그인 상태로 로그인 주소를 열면 건너뛴다", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/products`);
  await page.goto(`/shop/${SLUG}/login?next=${encodeURIComponent(`/shop/${SLUG}/me`)}`);
  await page.getByLabel("아이디(이메일)").fill(LOGIN);
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/me$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/products$`));
  await page.goto(`/shop/${SLUG}/login`);
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}$`));
});

test("내 정보는 허브로 그룹별 링크를 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: "http://localhost:3100" } });
  await page.goto(`/shop/${SLUG}/me`);
  for (const name of ["주문 내역", "찜", "내 쿠폰함", "내 리뷰", "알림 설정"]) {
    await expect(page.locator("main").getByRole("link", { name })).toBeVisible();
  }
  await page.locator("main").getByRole("link", { name: "주문 내역" }).click();
  await expect(page).toHaveURL(/\/orders$/);
});

test("휴대폰: 카테고리 서랍이 열린 채 Back하면 서랍부터 닫히고, 서랍 링크 이동 뒤 Back은 이전 화면으로 간다 (UX-11)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/shop/${SLUG}`);
  await page.goto(`/shop/${SLUG}/help`);
  await page.getByRole("button", { name: "카테고리 메뉴" }).click();
  await expect(page.getByRole("dialog", { name: "카테고리 메뉴" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "카테고리 메뉴" })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/help$`));
  await page.getByRole("button", { name: "카테고리 메뉴" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "주문 조회" }).click();
  await expect(page).toHaveURL(/\/orders/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/help$`));
});

test("상품 상세 ← 버튼: 목록에서 들어오면 목록으로, 직접 들어오면 목록 화면으로 간다 (J-1)", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/products?sort=low`);
  await page.locator("a.pc-name").first().click();
  await expect(page).toHaveURL(/\/products\/[^/?]+$/);
  await page.getByRole("button", { name: "목록 화면으로" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/products\\?sort=low$`));
  const href = await page.locator("a.pc-name").first().getAttribute("href");
  await page.goto(href!);
  await page.getByRole("button", { name: "목록 화면으로" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/products$`));
});
