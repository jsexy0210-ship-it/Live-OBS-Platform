import { expect, type Page } from "@playwright/test";

// 모든 공개 공통 틀은 승인 심볼을 실제로 읽고 같은 이름으로 소개에 연결한다.
export async function expectPublicBrand(page: Page, favicon = "/branding/streamshop-symbol.png") {
  const brands = page.locator('.pf-head [aria-label="스트림샵"], .pf-foot [aria-label="스트림샵"]');
  await expect(brands).toHaveText(["streamshop", "streamshop"]);
  await expect(page.locator('.pf-head .logo-sym, .pf-foot .logo-sym, .pf-head .logo-word, .pf-foot .logo-word')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "스트림샵 서비스 소개", exact: true })).toHaveAttribute("href", "/about");
  for (const image of await brands.locator("img").all()) {
    await expect(image).toHaveAttribute("src", /streamshop-symbol/);
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
  await expect(page).toHaveTitle(/스트림샵/);
  expect((await page.locator('link[rel="icon"]').last().getAttribute("href")) ?? "").toContain(favicon);
}
