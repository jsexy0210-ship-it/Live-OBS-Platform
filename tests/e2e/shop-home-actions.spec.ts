import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

const SLUG = "demo-shop", HOME = `/shop/${SLUG}`, API = `/api/shop/${SLUG}`;
const optionA = "10000000-0000-4000-8000-000000000001", optionB = "10000000-0000-4000-8000-000000000002";
const option = (id: string, name: string, soldOut = false) => ({ id, name, soldOut, price: 10000, salePrice: null, stockLeft: 5 });

test.beforeEach(async ({ baseURL }) => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (process.env.CI !== "true" || process.env.NODE_ENV === "production" || !baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("홈 동작 회귀는 폐기 CI에서만 실행합니다");
});

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`${API}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: process.env.E2E_PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

async function fixture(page: Page) {
  const writes: { path: string; method: string; body: unknown }[] = [];
  let options = [option(optionA, "소유 옵션 A")], cartFailure: { error: string; status: number } | null = null;
  let wished: string[] = [];
  await page.route(`**${API}/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === `${API}/wishlist`) return route.fulfill({ json: { productIds: wished } });
      if (path === `${API}/cart/count`) return route.fulfill({ json: { count: 0 } });
      if (path.startsWith(`${API}/products/`) && /^[0-9a-f-]{36}$/i.test(path.slice(`${API}/products/`.length))) return route.fulfill({ json: { product: { id: path.split("/").pop(), options } } });
      return route.continue();
    }
    // 인증은 준비 단계에서만 실제로 한다. 카드의 쓰기는 전부 이 소유 응답으로 끝낸다.
    expect(path === `${API}/cart` || path === `${API}/wishlist` || path.startsWith(`${API}/wishlist/`)).toBe(true);
    const body = request.method() === "DELETE" ? null : request.postDataJSON();
    writes.push({ path, method: request.method(), body });
    if (path === `${API}/cart`) return cartFailure ? route.fulfill({ status: cartFailure.status, json: { error: cartFailure.error } }) : route.fulfill({ status: 201, json: { item: { id: "owned-cart", quantity: 1 }, count: 1 } });
    wished = request.method() === "DELETE" ? wished.filter(id => id !== path.split("/").pop()) : [...new Set([...wished, body.productId])];
    return route.fulfill({ json: { count: wished.length } });
  });
  return { writes, options: (next: typeof options) => { options = next; }, cartFailure: (failure: typeof cartFailure) => { cartFailure = failure; } };
}

const card = (page: Page) => page.locator(".shop-home .pc").filter({ has: page.locator(".home-card-cart:not(:disabled)") }).first();

test("비회원 홈 담기·찜은 같은 쇼핑몰의 로그인 안내로 연결하고 쓰지 않는다", async ({ page }) => {
  const owned = await fixture(page);
  await page.goto(HOME);
  for (const name of ["담기", "찜"]) {
    await card(page).getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "로그인이 필요해요" });
    await expect(dialog.getByRole("link", { name: "로그인", exact: true })).toHaveAttribute("href", `${HOME}/login?next=${encodeURIComponent(HOME)}`);
    await dialog.getByRole("button", { name: "둘러보기", exact: true }).click();
  }
  expect(owned.writes).toEqual([]);
});

test("회원 홈의 단일·복수 옵션 담기와 찜 토글은 기존 API에 정확한 대상을 보낸다", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const owned = await fixture(page);
  await page.goto(HOME);
  const selected = card(page), href = await selected.locator(".pc-name").getAttribute("href"), productId = href!.split("/").pop()!;
  await expect(selected.getByRole("button", { name: "찜", exact: true })).toBeEnabled();
  await selected.getByRole("button", { name: "찜", exact: true }).click();
  await expect(selected.getByRole("button", { name: "찜 빼기", exact: true })).toHaveAttribute("aria-pressed", "true");
  await selected.getByRole("button", { name: "찜 빼기", exact: true }).click();
  await expect(selected.getByRole("button", { name: "찜", exact: true })).toHaveAttribute("aria-pressed", "false");
  await selected.getByRole("button", { name: "담기", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "장바구니에 담았어요" })).toBeVisible();
  owned.options([option(optionA, "소유 옵션 A"), option(optionB, "소유 옵션 B")]);
  await selected.getByRole("button", { name: "담기", exact: true }).click();
  const choice = page.getByRole("dialog", { name: /옵션 선택$/ });
  await choice.getByLabel("상품 옵션").selectOption(optionB);
  await choice.getByRole("button", { name: "취소", exact: true }).click();
  expect(owned.writes.filter(w => w.path === `${API}/cart`)).toHaveLength(1);
  await selected.getByRole("button", { name: "담기", exact: true }).click();
  await choice.getByLabel("상품 옵션").selectOption(optionB);
  await choice.getByRole("button", { name: "담기", exact: true }).click();
  await expect(choice).toHaveCount(0);
  expect(owned.writes).toEqual([
    { path: `${API}/wishlist`, method: "POST", body: { productId } },
    { path: `${API}/wishlist/${productId}`, method: "DELETE", body: null },
    { path: `${API}/cart`, method: "POST", body: { optionId: optionA, quantity: 1 } },
    { path: `${API}/cart`, method: "POST", body: { optionId: optionB, quantity: 1 } },
  ]);
  owned.options([option(optionA, "소유 옵션 A", true)]);
  await selected.getByRole("button", { name: "담기", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "담을 수 있는 옵션이 없어요" })).toBeVisible();
  expect(owned.writes).toHaveLength(4);
});

test("홈 담기의 기존 미성년자 거부와 세션 만료 응답을 성공으로 표시하지 않는다", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const owned = await fixture(page);
  await page.goto(HOME);
  owned.cartFailure({ error: "minor_blocked", status: 403 });
  await card(page).getByRole("button", { name: "담기", exact: true }).click();
  await expect(page.getByText("만 19세 이상만 주문할 수 있어요", { exact: true })).toBeVisible();
  await expect(page.getByText("장바구니에 담았어요", { exact: true })).toHaveCount(0);
  owned.cartFailure({ error: "unauthenticated", status: 401 });
  await card(page).getByRole("button", { name: "담기", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "로그인이 필요해요" })).toBeVisible();
  expect(owned.writes.map(w => w.body)).toEqual([{ optionId: optionA, quantity: 1 }, { optionId: optionA, quantity: 1 }]);
});
