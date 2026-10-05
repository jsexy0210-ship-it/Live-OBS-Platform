import { expect, test, type Page } from "@playwright/test";
import { resetCartInDb, setOptionPriceDeltaInDb, setOptionStockInDb } from "./cartDb";

// IA ⑤ 장바구니 상태: 담은 뒤 가격 바뀜 안내·확인(이 기기에 기억), 재고 부족 안내와 「n개로 줄이기」, 남은 수량.
// 데모 「문라이트 컬렉션 박스」 1박스 옵션을 쓰고 끝에 재고·추가금·장바구니를 되돌린다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const PRODUCT = "문라이트 컬렉션 박스";
const OPTION = "1박스";
let prevStock = 0;
let prevDelta = 0;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  prevStock = await setOptionStockInDb(SLUG, PRODUCT, OPTION, 50);
  prevDelta = await setOptionPriceDeltaInDb(SLUG, PRODUCT, OPTION, 0);
});
test.afterAll(async () => {
  await setOptionStockInDb(SLUG, PRODUCT, OPTION, prevStock);
  await setOptionPriceDeltaInDb(SLUG, PRODUCT, OPTION, prevDelta);
  await resetCartInDb(SLUG, LOGIN, []);
});

async function addViaApi(page: Page, baseURL: string, quantity: number) {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  const p = list.products.find((x) => x.name === PRODUCT)!;
  const d = (await (await page.request.get(`/api/shop/${SLUG}/products/${p.id}`)).json()) as { product: { options: { id: string; name: string }[] } };
  const optionId = d.product.options.find((o) => o.name === OPTION)!.id;
  const r = await page.request.post(`/api/shop/${SLUG}/cart`, { data: { optionId, quantity }, headers: { origin: baseURL } });
  expect(r.ok()).toBe(true);
}

test("담은 뒤 가격이 바뀌면 안내가 뜨고, 확인하면 숨고, 또 바뀌면 다시 뜬다", async ({ page, baseURL }) => {
  await resetCartInDb(SLUG, LOGIN, []);
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  await addViaApi(page, baseURL!, 1);
  await page.goto(`/shop/${SLUG}/cart`);
  await expect(page.getByText(PRODUCT)).toBeVisible();
  await expect(page.locator(".cart-price-tag")).toHaveCount(0);

  await setOptionPriceDeltaInDb(SLUG, PRODUCT, OPTION, 1000);
  await page.reload();
  const tag = page.locator(".cart-price-tag");
  await expect(tag).toContainText("담은 뒤 가격이 올랐어요");
  await expect(page.getByText(/담은 뒤 가격이 바뀐 상품이 1개 있어요/)).toBeVisible();
  await tag.getByRole("button", { name: "바뀐 가격 확인했어요" }).click();
  await expect(page.locator(".cart-price-tag")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".cart-price-tag")).toHaveCount(0); // 이 기기에 기억

  await setOptionPriceDeltaInDb(SLUG, PRODUCT, OPTION, 2000);
  await page.reload();
  await expect(page.locator(".cart-price-tag")).toContainText("담은 뒤 가격이");
});

test("재고보다 많이 담긴 줄은 최대 수량을 알려 주고 「n개로 줄이기」로 맞춘다", async ({ page, baseURL }) => {
  await setOptionPriceDeltaInDb(SLUG, PRODUCT, OPTION, 0);
  await resetCartInDb(SLUG, LOGIN, []);
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  await addViaApi(page, baseURL!, 3);
  await setOptionStockInDb(SLUG, PRODUCT, OPTION, 2);
  await page.goto(`/shop/${SLUG}/cart`);
  const tag = page.locator(".cart-tag", { hasText: "재고가 부족해요" });
  await expect(tag).toContainText("최대 2개");
  await tag.getByRole("button", { name: "2개로 줄이기" }).click();
  await expect(page.locator(".cart-tag", { hasText: "재고가 부족해요" })).toHaveCount(0);
  await expect(page.getByLabel("수량 2개")).toBeVisible();
  await expect(page.getByRole("button", { name: "수량 늘리기" })).toBeDisabled(); // 재고가 2개라 더 못 늘림
  await expect(page.locator(".cart-tag", { hasText: "개 남았어요" })).toContainText("2개 남았어요");
});
