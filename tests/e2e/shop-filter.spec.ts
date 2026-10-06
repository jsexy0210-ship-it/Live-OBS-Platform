import { expect, test, type Page } from "@playwright/test";
import { resetCategoriesInDb } from "./categoryDb";

// SH-002 필터(보드 SH-002-F · SH-002-PC-IA 「검색 조건」, 서버 #867): PC 왼쪽 패널 · 휴대폰 아래 시트 · 적용한 조건 칩 · 결과 없음 · 관련도순. 실제 서버·DB.
const SLUG = "demo-shop";

test.beforeAll(() => resetCategoriesInDb(SLUG, true));
test.afterAll(() => resetCategoriesInDb(SLUG, false));

const names = (page: Page) => page.locator(".pc .pc-name").allTextContents();
const panel = (page: Page) => page.getByRole("form", { name: "검색 조건" });
const shot = (page: Page, name: string) => page.screenshot({ path: `tests/e2e/screenshots/SH-002-filter-${name}.png` });

test("PC: 검색 조건 패널 — 재고·가격 적용, 칩의 ×로 하나씩, 모두 지우기", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/products`);
  await expect(panel(page).getByRole("heading", { name: "검색 조건" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "필터" })).toBeHidden(); // 시트 제목은 휴대폰 전용
  const all = await names(page);
  expect(all).toContain("드래곤 소울 부스터"); // 품절 상품

  await panel(page).getByLabel("재고 있는 상품만").check();
  await panel(page).getByRole("button", { name: "적용" }).click();
  await expect(page).toHaveURL(/inStock=1/);
  const applied = page.getByLabel("적용한 조건");
  await expect(applied.getByRole("link", { name: "재고 있는 상품만 조건 지우기" })).toBeVisible();
  expect(await names(page)).not.toContain("드래곤 소울 부스터");

  await panel(page).getByLabel("최소 가격").fill("100000");
  await panel(page).getByRole("button", { name: "적용" }).click();
  await expect(page).toHaveURL(/minPrice=100000/);
  await expect(applied).toContainText("100,000원 이상");
  await expect.poll(() => names(page)).toEqual(["문라이트 컬렉션 박스", "스타라이트 부스터 박스"]);
  await shot(page, "pc-applied-1440");

  await applied.getByRole("link", { name: "재고 있는 상품만 조건 지우기" }).click(); // 칩 하나만 빠진다
  await expect(page).not.toHaveURL(/inStock/);
  await expect(page).toHaveURL(/minPrice=100000/);
  await applied.getByRole("link", { name: "모두 지우기" }).click();
  await expect(page).not.toHaveURL(/minPrice|inStock/);
  await expect(page.getByLabel("적용한 조건")).toHaveCount(0);
});

test("PC: 최대가 최소보다 작으면 오류·적용 꺼짐, 맞는 상품이 없으면 안내", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/products`);
  await panel(page).getByLabel("최소 가격").fill("5000");
  await panel(page).getByLabel("최대 가격").fill("1000");
  await expect(panel(page).getByRole("alert")).toHaveText("최대 가격이 최소 가격보다 작아요");
  await expect(panel(page).getByRole("button", { name: "적용" })).toBeDisabled();
  await shot(page, "pc-price-error-1440");
  // 맞는 상품이 없는 조건은 주소로 들어와도 안내와 「필터 모두 지우기」
  await page.goto(`/shop/${SLUG}/products?minPrice=90000000`);
  await expect(page.getByText("필터 조건에 맞는 상품이 없어요. 필터를 줄여 보세요")).toBeVisible();
  await page.getByRole("link", { name: "필터 모두 지우기" }).click();
  await expect(page).not.toHaveURL(/minPrice/);
  expect((await names(page)).length).toBeGreaterThan(0);
  // 이상한 값은 버려진다(오류 화면 없음)
  await page.goto(`/shop/${SLUG}/products?minPrice=abc&cats=없는분류&inStock=2`);
  expect((await names(page)).length).toBeGreaterThan(0);
});

test("검색: 기본 정렬은 관련도순, 필터가 검색어와 함께 이어진다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/search?q=${encodeURIComponent("부스터")}`);
  const nav = page.getByRole("navigation", { name: "정렬" });
  await expect(nav.locator("summary")).toHaveText("관련도순");
  await nav.locator("summary").click();
  await expect(nav.getByRole("link")).toHaveText(["관련도순", "추천순", "인기순", "신상품", "낮은 가격", "높은 가격"]);
  await page.keyboard.press("Escape");
  await panel(page).getByLabel("재고 있는 상품만").check();
  await panel(page).getByRole("button", { name: "적용" }).click();
  await expect(page).toHaveURL(/q=%EB%B6%80%EC%8A%A4%ED%84%B0/);
  await expect(page).toHaveURL(/inStock=1/);
  expect(await names(page)).not.toContain("드래곤 소울 부스터");
  await expect(page.getByRole("navigation", { name: "정렬" }).locator("summary")).toHaveText("관련도순");
  await shot(page, "search-1440");
});

for (const vp of [
  { name: "390", w: 390, h: 844 },
  { name: "1024", w: 1024, h: 800 },
]) {
  test(`${vp.name}: 필터 ${vp.name === "390" ? "시트(분류·가격·재고·정렬·상품 N개 보기)" : "패널"}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(`/shop/${SLUG}/products`);
    if (vp.name === "1024") {
      await expect(panel(page)).toBeVisible();
      await shot(page, "1024");
      return;
    }
    await expect(panel(page)).toBeHidden(); // 시트는 닫혀 있다
    await page.getByRole("button", { name: /^필터/ }).click();
    const sheet = panel(page);
    await expect(sheet.getByRole("heading", { name: "필터" })).toBeVisible();
    await expect(sheet.getByRole("group", { name: "부스터 박스" })).toBeVisible();
    await sheet.getByRole("button", { name: "프리미엄" }).click();
    await sheet.getByLabel("재고 있는 상품만").check();
    await expect(sheet.getByRole("button", { name: /^상품 \d+개 보기$/ })).toBeVisible();
    await expect(sheet.getByRole("radio", { name: "신상품" })).toBeChecked();
    await page.evaluate(() => document.fonts.ready);
    await shot(page, "sheet-390");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden(); // Esc로 닫힘
    await page.getByRole("button", { name: /^필터/ }).click();
    await sheet.getByRole("button", { name: /^상품 \d+개 보기$/ }).click();
    await expect(page).toHaveURL(/cats=/);
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: /^필터 2/ })).toBeVisible(); // 걸린 조건 개수(분류 1 + 재고 1)
    await expect(page.getByLabel("적용한 조건").getByRole("link", { name: "프리미엄 조건 지우기" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, "applied-390");
  });
}
