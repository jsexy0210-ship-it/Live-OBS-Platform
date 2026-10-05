import { expect, test, type Page } from "@playwright/test";
import { resetWishlistInDb } from "./cartDb";
import { okConfirm } from "./shopConfirm";

// SH-034 찜(운영 빌드 + 데모 시드). 데모 구매자(demo-buyer1@example.com)의 찜을 시작·끝에 비운다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(() => resetWishlistInDb(SLUG, LOGIN, []));

test("비회원: 로그인 안내", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/wishlist`);
  await expect(page.getByText("로그인하면 찜한 상품을 볼 수 있어요.")).toBeVisible();
  await expect(page.getByRole("link", { name: "로그인", exact: true }).last()).toHaveAttribute("href", /\/login\?next=/);
});

test.describe.serial("로그인 구매자", () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await resetWishlistInDb(SLUG, LOGIN, ["스타라이트 부스터 박스", "문라이트 컬렉션 박스", "드래곤 소울 부스터"]);
    await login(page, baseURL!);
  });

  test("PC: 머리 찜 링크로 들어와 왼쪽 메뉴·카드·품절 띠가 보인다", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/shop/${SLUG}`);
    await page.locator(".shop-hics").getByRole("link", { name: "찜" }).click();
    await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/wishlist$`));
    await expect(page.getByRole("heading", { name: "찜", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "내 정보 메뉴" }).getByRole("link", { name: "찜" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: /^찜 3$/ })).toBeVisible();
    const cards = page.getByRole("list", { name: "찜한 상품" }).locator(".pc");
    await expect(cards).toHaveCount(3);
    await expect(cards.filter({ hasText: "드래곤 소울 부스터" }).locator(".pc-out")).toHaveText("품절");
    await expect(cards.filter({ hasText: "스타라이트 부스터 박스" }).locator(".pc-out")).toHaveCount(0);
    await page.screenshot({ path: "tests/e2e/screenshots/SH-034-wishlist-1440.png", fullPage: true });
  });

  test("찜 빼기·품절 상품 빼기·모두 비우기(확인 창)·빈 상태", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/shop/${SLUG}/wishlist`);
    const cards = page.getByRole("list", { name: "찜한 상품" }).locator(".pc");
    await cards.filter({ hasText: "문라이트 컬렉션 박스" }).getByRole("button", { name: "찜 빼기" }).click();
    await expect(page.getByRole("status")).toContainText("찜에서 뺐어요");
    await expect(cards).toHaveCount(2);
    await page.getByRole("button", { name: "품절 상품 빼기" }).click();
    await okConfirm(page, "빼기");
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole("button", { name: "품절 상품 빼기" })).toBeDisabled();
    await page.getByRole("button", { name: "모두 비우기" }).click();
    const dlg = page.getByRole("dialog", { name: "1개를 모두 뺄까요?" });
    await dlg.getByRole("button", { name: "닫기" }).click();
    await expect(cards).toHaveCount(1);
    await page.getByRole("button", { name: "모두 비우기" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "모두 빼기" }).click();
    await expect(page.getByRole("heading", { name: "찜한 상품이 없어요" })).toBeVisible();
  });

  test("휴대폰 390: 메뉴가 위에 쌓이고 가로 스크롤 없음", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/shop/${SLUG}/wishlist`);
    await expect(page.getByRole("list", { name: "찜한 상품" }).locator(".pc")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "tests/e2e/screenshots/SH-034-wishlist-390.png", fullPage: true });
  });
});
