import { expect, test, type Page } from "@playwright/test";
import { resetCartInDb, resetWishlistInDb } from "./cartDb";

// UX 감사 ②: 가벼운 쇼핑 행동(담기·찜·수량 변경)은 확인 창 없이 바로 하고, 결과 줄의 「되돌리기」로 돌린다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const NAME = "스타라이트 부스터 박스";

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
async function productUrl(page: Page) {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  return `/shop/${SLUG}/products/${list.products.find((p) => p.name === NAME)!.id}`;
}
const cartCount = async (page: Page) => ((await (await page.request.get(`/api/shop/${SLUG}/cart/count`)).json()) as { count: number }).count;
const cartQty = async (page: Page) => ((await (await page.request.get(`/api/shop/${SLUG}/cart`)).json()) as { items: { quantity: number }[] }).items.map((i) => i.quantity);

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.beforeEach(async ({ page, baseURL }) => {
  await resetCartInDb(SLUG, LOGIN, []);
  await resetWishlistInDb(SLUG, LOGIN, []);
  await login(page, baseURL!);
});
test.afterAll(async () => {
  await resetCartInDb(SLUG, LOGIN, []);
  await resetWishlistInDb(SLUG, LOGIN, []);
});

test("장바구니 담기: 확인 창 없이 담기고, 되돌리기로 뺀다", async ({ page }) => {
  await page.goto(await productUrl(page));
  await page.locator(".pd-cart").click();
  await expect(page.locator(".pd-msg")).toContainText("장바구니에 담았어요");
  expect(await cartCount(page)).toBe(1);
  await page.locator(".pd-msg").getByRole("button", { name: "되돌리기" }).click();
  await expect(page.locator(".pd-msg")).toContainText("담기를 되돌렸어요");
  expect(await cartCount(page)).toBe(0);
});

test("이미 담긴 상품을 또 담으면 되돌리기는 이전 수량으로 돌린다", async ({ page }) => {
  await resetCartInDb(SLUG, LOGIN, [{ productName: NAME, quantity: 2 }]);
  await page.goto(await productUrl(page));
  await page.locator(".pd-cart").click();
  await expect(page.locator(".pd-msg")).toContainText("장바구니에 담았어요");
  expect(await cartQty(page)).toEqual([3]);
  await page.locator(".pd-msg").getByRole("button", { name: "되돌리기" }).click();
  await expect(page.locator(".pd-msg")).toContainText("담기를 되돌렸어요");
  expect(await cartQty(page)).toEqual([2]);
});

test("찜: 찜하고 되돌리면 빠지고, 빼고 되돌리면 다시 찜한다", async ({ page }) => {
  await page.goto(await productUrl(page));
  const wish = page.locator(".pd-wish");
  await wish.click();
  await expect(page.locator(".pd-msg")).toContainText("찜했어요");
  await expect(wish).toHaveAttribute("aria-pressed", "true");
  await page.locator(".pd-msg").getByRole("button", { name: "되돌리기" }).click();
  await expect(wish).toHaveAttribute("aria-pressed", "false");
  await wish.click();
  await wish.click();
  await expect(page.locator(".pd-msg")).toContainText("찜에서 뺐어요");
  await page.locator(".pd-msg").getByRole("button", { name: "되돌리기" }).click();
  await expect(wish).toHaveAttribute("aria-pressed", "true");
});

test("장바구니 수량 변경: 바꾸면 결과 줄이 뜨고 되돌리기로 이전 수량", async ({ page }) => {
  await resetCartInDb(SLUG, LOGIN, [{ productName: NAME, quantity: 2 }]);
  await page.goto(`/shop/${SLUG}/cart`);
  await page.getByRole("button", { name: "수량 늘리기" }).click();
  const msg = page.locator(".cart-msg", { hasText: "수량을 3개로 바꿨어요" });
  await expect(msg).toBeVisible();
  await msg.getByRole("button", { name: "되돌리기" }).click();
  await expect(page.locator(".cart-msg", { hasText: "수량을 2개로 되돌렸어요" })).toBeVisible();
  expect(await cartQty(page)).toEqual([2]);
});

test("찜 목록에서 마지막 상품을 빼도 결과 줄이 남아 되돌리기로 다시 찜한다", async ({ page }) => {
  await resetWishlistInDb(SLUG, LOGIN, [NAME]);
  await page.goto(`/shop/${SLUG}/wishlist`);
  const cards = page.getByRole("list", { name: "찜한 상품" }).locator(".pc");
  await expect(cards).toHaveCount(1);
  await cards.getByRole("button", { name: "찜 빼기" }).click();
  await expect(page.getByRole("heading", { name: "찜한 상품이 없어요" })).toBeVisible();
  await expect(page.locator(".cart-msg")).toContainText("찜에서 뺐어요");
  await page.locator(".cart-msg").getByRole("button", { name: "되돌리기" }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.locator(".cart-msg")).toContainText("다시 찜했어요");
});
