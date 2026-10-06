import { expect, test } from "@playwright/test";
import { addFillerProducts, removeFillerProducts } from "./cartDb";

// SH-002 숫자 페이저 · 목록 끝 안내 · 정렬 드롭다운: 판매 중 상품을 더해 두 쪽으로 만들어 실제로 확인한다(끝나면 지움).
const SLUG = "demo-shop";

test.beforeAll(async () => {
  await removeFillerProducts(SLUG);
  await addFillerProducts(SLUG, 22); // 시드 6개 + 22개 = 28개 → 24개씩 2쪽
});
test.afterAll(() => removeFillerProducts(SLUG));

for (const vp of [
  { name: "1440", w: 1440, h: 900 },
  { name: "1024", w: 1024, h: 800 },
  { name: "390", w: 390, h: 844 },
]) {
  test(`${vp.name}: 숫자 페이저 · 목록 끝 · 정렬 드롭다운`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(`/shop/${SLUG}/products`);
    const pager = page.getByRole("navigation", { name: "쪽 이동" });
    await expect(pager.getByRole("link", { name: "1쪽" })).toHaveAttribute("aria-current", "page");
    await expect(pager.getByRole("link", { name: "2쪽" })).toBeVisible();
    await expect(pager.getByRole("link", { name: "다음 쪽" })).toBeVisible();
    await expect(page.getByText("상품을 모두 봤어요")).toHaveCount(0); // 첫 쪽에는 끝 안내 없음
    // 정렬 드롭다운 열린 상태
    await page.getByRole("navigation", { name: "정렬" }).locator("summary").click();
    await expect(page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `tests/e2e/screenshots/SH-002-list-p1-sort-open-${vp.name}.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" })).toBeHidden(); // Esc로 닫힘
    await page.getByRole("navigation", { name: "정렬" }).locator("summary").click();
    await page.getByRole("heading", { name: /전체 상품/ }).click(); // 바깥을 누르면 닫힘
    await expect(page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" })).toBeHidden();
    await page.getByRole("navigation", { name: "정렬" }).locator("summary").click(); // 연 채로 쪽을 옮겨도 새 쪽에서는 닫혀 있다
    // 끝 쪽
    await pager.getByRole("link", { name: "2쪽" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByRole("navigation", { name: "쪽 이동" }).getByRole("link", { name: "2쪽" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" })).toBeHidden();
    await expect(page.getByText("상품을 모두 봤어요 · 28개")).toBeVisible();
    await expect(page.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", `/shop/${SLUG}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // 링크 모양 보조 버튼은 마우스를 올려도 글자가 보인다(예전에는 흰 글자로 바뀌어 사라졌음)
    const home = page.getByRole("link", { name: "홈으로" });
    await home.hover();
    expect(await home.evaluate((el) => getComputedStyle(el).color)).not.toBe("rgb(255, 255, 255)");
    await page.goto(`/shop/${SLUG}/products?page=2`); // 증거 캡처는 주소로 바로 열어 찍는다(쪽 이동 직후에는 새로 쓰인 글자의 글꼴 조각이 늦게 받아져 일부 글자가 비어 찍힘)
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // 끝까지 내려 아래 고정 바에 가린 것이 없는지 본다
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    await page.locator(".shop-pager").locator("xpath=..").locator(".shop-listend").screenshot({ path: `tests/e2e/screenshots/SH-002-list-end-note-${vp.name}.png` }); // 목록 끝 안내만 따로(보이는 화면 캡처에서는 이 버튼 글자가 비어 찍혀 요소 캡처를 함께 둔다)
    await page.waitForTimeout(300);
    await page.screenshot({ path: `tests/e2e/screenshots/SH-002-list-p2-end-${vp.name}.png` }); // 아래 고정 바가 있는 휴대폰은 보이는 화면 그대로(전체 쪽 캡처는 고정 바가 겹쳐 찍힘)
  });
}
