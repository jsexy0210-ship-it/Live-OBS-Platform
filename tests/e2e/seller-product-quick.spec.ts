import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 상품 목록 빠른 처리(판매 상태·재고)와 목록 조건 쿼리(?stock=out, ?display=shown): 시험용 상품을 만들어 실제 API로 확인하고, 끝나면 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const PREFIX = "빠른수정e2e";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

const login = async (page: Page, email = "demo-owner@example.com") => {
  await page.goto("/seller/login");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/products$/);
};
type Made = { id: string; optionId: string | null };
const make = (page: Page, name: string, status: string, stock: number | null) =>
  page.evaluate(
    async ({ name, status, stock }) => {
      const body = { name, price: 1000, status, stockDeductMode: "PAYMENT", options: stock === null ? [] : [{ name: "기본", priceDelta: 0, stock, sortOrder: 0 }] };
      const r = await fetch("/api/seller/products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const p = await r.json();
      if (!r.ok) throw new Error(`상품 만들기 실패 ${r.status} ${JSON.stringify(p)}`);
      return { id: p.id as string, optionId: (p.options?.[0]?.id ?? null) as string | null };
    },
    { name, status, stock },
  ) as Promise<Made>;
const serverProduct = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const p = await (await fetch(`/api/seller/products/${id}`)).json();
    return { status: p.status as string, price: p.price as number, stock: (p.options?.[0]?.stock ?? null) as number | null };
  }, id);
const row = (page: Page, name: string) => page.getByTestId("product-row").filter({ hasText: name });

test.afterEach(async ({ page }) => {
  if (!page.url().includes("/seller/products")) return;
  await page.evaluate(async (prefix) => {
    const list = await (await fetch(`/api/seller/products?q=${encodeURIComponent(prefix)}&limit=100`)).json();
    const ids = (list.products ?? []).filter((p: { name: string }) => p.name.startsWith(prefix)).map((p: { id: string }) => p.id);
    if (ids.length) await fetch("/api/seller/products/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", productIds: ids }) });
  }, PREFIX);
});

test("판매 상태를 목록에서 바꾸면 서버에 반영되고, 서버가 막으면 원래 값으로 되돌리고 이유를 알린다", async ({ page }) => {
  await login(page);
  const sale = await make(page, `${PREFIX}-판매`, "ON_SALE", 10);
  const empty = await make(page, `${PREFIX}-옵션없음`, "HIDDEN", null);
  await page.goto(`/seller/products?q=${encodeURIComponent(PREFIX)}`);
  const a = row(page, `${PREFIX}-판매`);
  await expect(a).toContainText("노출");
  await a.getByRole("combobox", { name: /판매 상태/ }).selectOption("HIDDEN");
  await expect(page.getByText("판매 상태를 숨김(으)로 바꿨습니다")).toBeVisible();
  expect((await serverProduct(page, sale.id)).status).toBe("HIDDEN");
  await expect(a).toContainText("비노출");

  // 옵션이 없는 숨김 상품은 판매 중으로 못 바꾼다: 서버 거절 → 원래 값 숨김, 이유 표시
  const b = row(page, `${PREFIX}-옵션없음`);
  await b.getByRole("combobox", { name: /판매 상태/ }).selectOption("ON_SALE");
  await expect(page.getByRole("status").filter({ hasText: /판매|옵션/ }).first()).toBeVisible();
  await expect(b.getByRole("combobox", { name: /판매 상태/ })).toHaveValue("HIDDEN");
  expect((await serverProduct(page, empty.id)).status).toBe("HIDDEN");
});

test("재고를 목록에서 바꾸면 서버에 반영되고, 그사이 바뀌었으면 저장하지 않고 지금 재고를 보여 준다", async ({ page }) => {
  await login(page);
  const p = await make(page, `${PREFIX}-재고`, "ON_SALE", 10);
  await page.goto(`/seller/products?q=${encodeURIComponent(PREFIX)}`);
  const input = row(page, `${PREFIX}-재고`).getByRole("textbox", { name: /재고$/ });
  await expect(input).toHaveValue("10");
  await input.fill("7");
  expect((await serverProduct(page, p.id)).stock).toBe(10);
  await input.press("Enter");
  await expect(page.getByText("재고를 7개로 바꿨습니다")).toBeVisible();
  expect((await serverProduct(page, p.id)).stock).toBe(7);

  // 다른 곳에서 재고가 3으로 바뀐 뒤 화면에서 5로 바꾸려 하면 막힌다
  await page.evaluate(async ({ id, optionId }) => {
    await fetch(`/api/seller/products/${id}/options/${optionId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stock: 3, expectedStock: 7 }) });
  }, { id: p.id, optionId: p.optionId });
  await input.fill("5");
  await input.press("Enter");
  await expect(page.getByText("그사이 「" + PREFIX + "-재고」 재고가 변경되었습니다")).toBeVisible();
  await expect(input).toHaveValue("3");
  expect((await serverProduct(page, p.id)).stock).toBe(3);

  // 잘못된 값은 원래 값으로 되돌린다
  await input.fill("abc");
  await input.press("Enter");
  await expect(page.getByText("재고는 0개 이상의 숫자로 입력해 주십시오")).toBeVisible();
  await expect(input).toHaveValue("3");
  expect((await serverProduct(page, p.id)).stock).toBe(3);
});

test("판매가를 목록에서 바꾸고, 판매가·판매 상태·재고 변경은 토스트의 되돌리기로 원래 값을 되찾는다", async ({ page }) => {
  await login(page);
  const p = await make(page, `${PREFIX}-되돌리기`, "ON_SALE", 10);
  await page.goto(`/seller/products?q=${encodeURIComponent(PREFIX)}`);
  const r = row(page, `${PREFIX}-되돌리기`);
  const undo = page.getByRole("button", { name: "되돌리기", exact: true });

  // 판매가
  const priceButton = r.getByRole("button", { name: /가격 변경/ });
  await expect(priceButton).toHaveText("1,000원");
  await priceButton.click();
  const price = r.getByRole("textbox", { name: /가격$/ });
  await expect(price).toHaveValue("1000");
  await price.fill("2500");
  await price.press("Enter");
  await expect(page.getByText("판매가를 2,500원으로 바꿨습니다")).toBeVisible();
  expect((await serverProduct(page, p.id)).price).toBe(2500);
  await undo.click();
  await expect(page.getByText("판매가를 되돌렸습니다")).toBeVisible();
  expect((await serverProduct(page, p.id)).price).toBe(1000);
  await expect(priceButton).toHaveText("1,000원");
  // 0원 같은 값은 서버에 보내지 않고 원래 값으로 되돌린다
  await priceButton.click();
  await price.fill("0");
  await price.press("Enter");
  await expect(page.getByText("판매가는 1원 이상의 숫자로 입력해 주십시오")).toBeVisible();
  await expect(priceButton).toHaveText("1,000원");
  expect((await serverProduct(page, p.id)).price).toBe(1000);

  // 판매 상태
  await r.getByRole("combobox", { name: /판매 상태/ }).selectOption("SOLD_OUT");
  await expect(page.getByText("판매 상태를 품절(으)로 바꿨습니다")).toBeVisible();
  expect((await serverProduct(page, p.id)).status).toBe("SOLD_OUT");
  await undo.click();
  await expect(page.getByText("판매 상태를 되돌렸습니다")).toBeVisible();
  expect((await serverProduct(page, p.id)).status).toBe("ON_SALE");
  await expect(r.getByRole("combobox", { name: /판매 상태/ })).toHaveValue("ON_SALE");

  // 재고: 되돌리기 전에 다른 곳에서 재고가 또 바뀌었으면 되돌리지 않고 알린다
  const stock = r.getByRole("textbox", { name: /재고$/ });
  await stock.fill("7");
  await stock.press("Enter");
  await expect(page.getByText("재고를 7개로 바꿨습니다")).toBeVisible();
  await page.evaluate(async ({ id, optionId }) => {
    await fetch(`/api/seller/products/${id}/options/${optionId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stock: 4, expectedStock: 7 }) });
  }, { id: p.id, optionId: p.optionId });
  await undo.click();
  await expect(page.getByText("그사이 재고가 변경되어 되돌리지 않았습니다")).toBeVisible();
  expect((await serverProduct(page, p.id)).stock).toBe(4);
  // 바뀌지 않았으면 직전 값으로 돌아간다(여기서는 4)
  await expect(stock).toHaveValue("4");
  await stock.fill("9");
  await stock.press("Enter");
  await expect(page.getByText("재고를 9개로 바꿨습니다")).toBeVisible();
  await undo.click();
  await expect(page.getByText("재고를 되돌렸습니다")).toBeVisible();
  expect((await serverProduct(page, p.id)).stock).toBe(4);
  await expect(stock).toHaveValue("4");
});

test("목록 조건 쿼리: ?stock=out·?display=shown으로 열면 그 조건으로 걸러 보인다", async ({ page }) => {
  await login(page);
  await make(page, `${PREFIX}-재고없음`, "ON_SALE", 0);
  await make(page, `${PREFIX}-재고있음`, "ON_SALE", 50);
  await make(page, `${PREFIX}-숨김`, "HIDDEN", 50);
  await page.goto(`/seller/products?q=${encodeURIComponent(PREFIX)}&stock=out`);
  await expect(row(page, `${PREFIX}-재고없음`)).toHaveCount(1);
  await expect(row(page, `${PREFIX}-재고있음`)).toHaveCount(0);
  await page.goto(`/seller/products?q=${encodeURIComponent(PREFIX)}&display=shown`);
  await expect(row(page, `${PREFIX}-재고있음`)).toHaveCount(1);
  await expect(row(page, `${PREFIX}-숨김`)).toHaveCount(0);
});

test("상품 관리 권한이 없는 직원에게는 빠른 처리 칸이 보이지 않는다", async ({ page }) => {
  // 상품 관리(PRODUCT_MANAGE) 권한이 없는 배송 담당 직원(demo-viewer)으로 로그인한다. 시험용 상품은 만들지 않는다
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-viewer@example.com", PASSWORD);
  await page.goto(`/seller/products?q=${encodeURIComponent(PREFIX)}`);
  // 상품 목록 권한이 없으면 안내 화면이라 행이 없고, 있어도 입력 칸이 없다
  await expect(page.getByRole("combobox", { name: /판매 상태/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /재고$/ })).toHaveCount(0);
});

test("되돌리기: 그사이 다른 사람이 판매가·판매 상태를 또 바꿨으면 되돌리지 않고 지금 값을 보여 준다", async ({ page }) => {
  await login(page);
  const p = await make(page, `${PREFIX}-되돌리기충돌`, "ON_SALE", 10);
  await page.goto(`/seller/products?q=${encodeURIComponent(PREFIX)}`);
  const r = row(page, `${PREFIX}-되돌리기충돌`);
  const undo = page.getByRole("button", { name: "되돌리기", exact: true });
  const patch = (body: Record<string, unknown>) =>
    page.evaluate(async ({ id, body }) => (await fetch(`/api/seller/products/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, { id: p.id, body });

  // 판매가: 2,500원으로 바꾼 뒤 다른 사람이 3,000원으로 바꿨다 → 되돌리기는 막히고 3,000원이 보인다
  const priceButton = r.getByRole("button", { name: /가격 변경/ });
  await priceButton.click();
  const price = r.getByRole("textbox", { name: /가격$/ });
  await price.fill("2500");
  await price.press("Enter");
  await expect(page.getByText("판매가를 2,500원으로 바꿨습니다")).toBeVisible();
  expect(await patch({ price: 3000 })).toBe(200);
  await undo.click();
  await expect(page.getByText("다른 사람이 먼저 바꿔서 되돌리지 않았습니다")).toBeVisible();
  expect((await serverProduct(page, p.id)).price).toBe(3000);
  await expect(priceButton).toHaveText("3,000원");

  // 판매 상태: 숨김으로 바꾼 뒤 다른 사람이 품절로 바꿨다 → 되돌리기는 막히고 품절이 보인다
  await r.getByRole("combobox", { name: /판매 상태/ }).selectOption("HIDDEN");
  await expect(page.getByText("판매 상태를 숨김(으)로 바꿨습니다")).toBeVisible();
  expect(await patch({ status: "SOLD_OUT" })).toBe(200);
  await undo.click();
  await expect(page.getByText("다른 사람이 먼저 바꿔서 되돌리지 않았습니다")).toBeVisible();
  expect((await serverProduct(page, p.id)).status).toBe("SOLD_OUT");
  await expect(r.getByRole("combobox", { name: /판매 상태/ })).toHaveValue("SOLD_OUT");
});
