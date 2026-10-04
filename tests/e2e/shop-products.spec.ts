import { expect, test } from "@playwright/test";
import { resetCategoriesInDb } from "./categoryDb";

// SH-002 상품 목록(운영 빌드 + 데모 시드): 머리·왼쪽 카테고리, 분류별 목록, 정렬, 휴대폰.
const SLUG = "demo-shop";
const SHOT = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => resetCategoriesInDb(SLUG, true));
test.afterAll(() => resetCategoriesInDb(SLUG, false));

const names = (page: import("@playwright/test").Page) => page.getByRole("list", { name: /./ }).locator(".pc .pc-name").allTextContents();
const expectNames = (page: import("@playwright/test").Page, want: string[]) => expect.poll(() => names(page)).toEqual(want);

test("PC: 머리 카테고리 → 분류 목록(하위 분류 상품 포함)·왼쪽 메뉴·정렬", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}`);
  const nav = page.locator(".shop-cats");
  await expect(nav.getByRole("link", { name: "전체 상품" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "비공개 분류" })).toHaveCount(0);
  await nav.getByRole("link", { name: "부스터 박스" }).click();
  await expect(page).toHaveURL(/\/products\?category=/);
  await expect(page.getByRole("heading", { level: 1, name: /^부스터 박스 2개$/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: "부스터 박스" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "전체 상품" })).not.toHaveAttribute("aria-current", "page");
  const side = page.getByRole("complementary", { name: "카테고리" });
  await expect(side.getByRole("link", { name: "부스터 박스" })).toHaveAttribute("aria-current", "page");
  await expect(side.getByRole("link", { name: "프리미엄" })).toBeVisible();
  await expect(side.getByRole("link", { name: "비공개 분류" })).toHaveCount(0);
  // 낮은 가격 순: 문라이트(132,000) → 스타라이트(189,000)
  await page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "낮은 가격" }).click();
  await expect(page).toHaveURL(/sort=low/);
  await expect(page).toHaveURL(/category=/);
  await expectNames(page, ["문라이트 컬렉션 박스", "스타라이트 부스터 박스"]);
  await page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" }).click();
  await expectNames(page, ["스타라이트 부스터 박스", "문라이트 컬렉션 박스"]);
  // 소분류
  await side.getByRole("link", { name: "프리미엄" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^프리미엄 1개$/ })).toBeVisible();
  await expectNames(page, ["문라이트 컬렉션 박스"]);
  await expect(nav.getByRole("link", { name: "부스터 박스" })).toHaveAttribute("aria-current", "page");
  if (SHOT) await page.screenshot({ path: "tests/e2e/screenshots/SH-002-list-1440.png" });
  // 전체 상품
  await side.getByRole("link", { name: "전체", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^전체 상품 \d+개$/ })).toBeVisible();
  await expect(page.locator(".pc").first()).toBeVisible();
});

test("보이지 않는 분류·없는 분류는 404", async ({ page }) => {
  const hidden = await page.request.get(`/shop/${SLUG}/products?category=00000000-0000-4000-8000-000000000000`);
  expect(hidden.status()).toBe(404);
  const bad = await page.request.get(`/shop/${SLUG}/products?category=abc`);
  expect(bad.status()).toBe(404);
});

test("휴대폰 390: 메뉴 탭·서랍에 카테고리, 왼쪽 메뉴는 숨김, 가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/shop/${SLUG}/products`);
  const tabs = page.getByRole("navigation", { name: "메뉴 탭" });
  await expect(tabs.getByRole("link", { name: "팩" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "카테고리" })).toBeHidden();
  await tabs.getByRole("link", { name: "부스터 박스" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^부스터 박스 2개$/ })).toBeVisible();
  await page.getByRole("button", { name: "카테고리 메뉴" }).click();
  const drawer = page.getByRole("dialog", { name: "카테고리 메뉴" });
  await expect(drawer.getByRole("link", { name: "프리미엄" })).toBeVisible();
  await drawer.getByRole("link", { name: "프리미엄" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^프리미엄 1개$/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (SHOT) await page.screenshot({ path: "tests/e2e/screenshots/SH-002-list-390.png" });
});
