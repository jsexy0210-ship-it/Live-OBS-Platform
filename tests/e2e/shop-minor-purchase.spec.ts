import { expect, test, type Page } from "@playwright/test";
import { resetCartInDb } from "./cartDb";

// 보드 SH-009 · SH-009-PC: 미성년자 구매 제한. 서버 #1231(프로필 minorPurchase, 담기·주문 403 minor_blocked · identity_reverify_required).
// 막는 쇼핑몰(만 19세 미만·생년월일 없음)은 데모 데이터에 없어 프로필·담기 응답만 같은 형태로 바꿔 보내고(route), 고지 후 허용(기본)은 실제 서버로 확인한다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = "tests/e2e/screenshots";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterEach(() => resetCartInDb(SLUG, LOGIN, []));

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
async function firstProductPath(page: Page) {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string; status?: string }[] };
  return `/shop/${SLUG}/products/${list.products.find((p) => p.name === "탑로더 25장")!.id}`;
}
const blockProfile = (page: Page, minorPurchase: unknown) =>
  page.route(`**/api/shop/${SLUG}/me/profile`, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...((await res.json()) as object), minorPurchase } });
  });

test("고지 후 허용(기본): 주문서에 고지 한 줄이 보이고 아무것도 막지 않는다", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const prof = (await (await page.request.get(`/api/shop/${SLUG}/me/profile`)).json()) as { minorPurchase: { policy: string; blocked: boolean } };
  expect(prof.minorPurchase).toMatchObject({ policy: "notice", blocked: false });
  await resetCartInDb(SLUG, LOGIN, [{ productName: "탑로더 25장", quantity: 1 }]);
  await page.goto(`/shop/${SLUG}/cart`);
  const cart = (await (await page.request.get(`/api/shop/${SLUG}/cart`)).json()) as { items: { id: string }[] };
  await page.goto(`/shop/${SLUG}/checkout?ids=${cart.items[0].id}`);
  await expect(page.getByText("만 19세 미만이 법정대리인 동의 없이 주문하면 본인이나 법정대리인이 취소할 수 있어요. 나이는 휴대폰 본인확인 생년월일로 확인해요.")).toBeVisible();
});

test("막는 쇼핑몰 · 만 19세 미만: 주문서는 안내 화면(홈으로 · 이용안내 보기)", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await resetCartInDb(SLUG, LOGIN, [{ productName: "탑로더 25장", quantity: 1 }]);
  const cart = (await (await page.request.get(`/api/shop/${SLUG}/cart`)).json()) as { items: { id: string }[] };
  await blockProfile(page, { policy: "block", blocked: true, reverifyRequired: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/checkout?ids=${cart.items[0].id}`);
  await expect(page.getByRole("heading", { name: "이 쇼핑몰은 만 19세 이상만 주문할 수 있어요", level: 1 })).toBeVisible();
  await expect(page.getByText("판매자가 미성년자 구매를 막아 두었어요. 나이는 휴대폰 본인확인의 생년월일로 확인해요. 상품은 볼 수 있어요.")).toBeVisible();
  await expect(page.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", `/shop/${SLUG}`);
  await expect(page.getByRole("link", { name: "이용안내 보기" })).toHaveAttribute("href", `/shop/${SLUG}/help`);
  await page.screenshot({ path: `${SHOTS}/sh009-blocked-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/sh009-blocked-390.png` });
});

test("막는 쇼핑몰 · 생년월일 없음: 판매자에게 문의하도록 안내(본인확인 다시 하기 흐름 전까지)", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await resetCartInDb(SLUG, LOGIN, [{ productName: "탑로더 25장", quantity: 1 }]);
  const cart = (await (await page.request.get(`/api/shop/${SLUG}/cart`)).json()) as { items: { id: string }[] };
  await blockProfile(page, { policy: "block", blocked: false, reverifyRequired: true });
  await page.goto(`/shop/${SLUG}/checkout?ids=${cart.items[0].id}`);
  await expect(page.getByRole("heading", { name: "나이를 확인할 수 없어요", level: 1 })).toBeVisible();
  await expect(page.getByText("판매자에게 문의해 주세요")).toBeVisible();
});

test("담기 · 바로 주문하기를 누르면 아래에 토스트 「만 19세 이상만 주문할 수 있어요」가 뜨고 화면은 그대로다", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.route(`**/api/shop/${SLUG}/cart`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 403, json: { error: "minor_blocked", message: "이 쇼핑몰은 만 19세 미만은 구매할 수 없어요" } });
  });
  const path = await firstProductPath(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(path);
  await page.getByRole("button", { name: "장바구니에 담기" }).click();
  const toast = page.getByRole("status").filter({ hasText: "만 19세 이상만 주문할 수 있어요" });
  await expect(toast).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/sh009-toast-1440.png` });
  await expect(toast).toHaveCount(0, { timeout: 8000 });
  await page.getByRole("button", { name: "바로 주문하기" }).click();
  await expect(toast).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
});

test("담기 403 identity_reverify_required: 판매자에게 문의해 달라는 토스트", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.route(`**/api/shop/${SLUG}/cart`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 403, json: { error: "identity_reverify_required", message: "나이를 확인할 수 없어요. 본인확인을 다시 해 주세요" } });
  });
  await page.goto(await firstProductPath(page));
  await page.getByRole("button", { name: "장바구니에 담기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "나이를 확인할 수 없어요. 판매자에게 문의해 주세요" })).toBeVisible();
});

test("나이 제한을 알 수 없으면(프로필 실패) 주문서를 열지 않는다", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await resetCartInDb(SLUG, LOGIN, [{ productName: "탑로더 25장", quantity: 1 }]);
  const cart = (await (await page.request.get(`/api/shop/${SLUG}/cart`)).json()) as { items: { id: string }[] };
  await page.route(`**/api/shop/${SLUG}/me/profile`, (route) => route.fulfill({ status: 500, json: { error: "server_error" } }));
  await page.goto(`/shop/${SLUG}/checkout?ids=${cart.items[0].id}`);
  await expect(page.getByText("주문서를 불러오지 못했어요.")).toBeVisible();
  await expect(page.getByRole("button", { name: /주문하기/ })).toHaveCount(0);
});
