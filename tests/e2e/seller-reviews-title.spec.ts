import { expect, test } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

const PASSWORD = process.env.E2E_PASSWORD ?? "";

test("SA-048 리뷰 표와 행 정보가 1440·1024·390 화면에서 보인다", async ({ page }) => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/reviews")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/reviews$/);
  await expect(page.getByRole("button", { name: "리뷰 설정" })).toBeVisible();

  const heading = page.getByRole("heading", { name: "리뷰", exact: true, level: 1 });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    if (width === 390) {
      await expect.poll(async () => {
        const box = await page.getByRole("complementary", { name: "파트너스 메뉴" }).boundingBox();
        return box ? box.x + box.width : 0;
      }).toBeLessThanOrEqual(0);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect.poll(() => page.evaluate(() => window.scrollX)).toBe(0);
    }
    await expect(heading).toBeVisible();
    const headingBox = await heading.boundingBox();
    expect(headingBox).not.toBeNull();
    expect(headingBox!.x + headingBox!.width).toBeLessThanOrEqual(width);
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    const row = page.getByTestId("review-row").first();
    await expect(row).toBeVisible();
    await expect(row.locator("td")).toHaveCount(6);
    for (const cell of [".rv-select", ".rv-item", ".rv-rating", ".rv-content", ".rv-status", ".rv-actions"]) {
      await expect(row.locator(cell)).toBeVisible();
    }
    await expect(row.locator(".rv-select input")).toBeDisabled();
    if (width !== 390) {
      await expect(table.getByRole("columnheader")).toHaveText(["", "상품 · 작성자", "별점", "내용 · 작성일", "상태", "관리"]);
    } else {
      await expect(row.locator(".rv-actions button")).toHaveCount(2);
      await expect(row.getByRole("button", { name: /리뷰 답글 관리/ })).toBeVisible();
      await expect(row.getByRole("button", { name: /리뷰 숨기기/ })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: `tests/e2e/screenshots/sa048-table-${width}.png`, fullPage: true });
  }
});
