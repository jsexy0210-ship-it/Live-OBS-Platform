import { expect, test } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

const PASSWORD = process.env.E2E_PASSWORD ?? "";

test("SA-048 리뷰 제목이 1440·1024·390 화면에서 정본과 일치한다", async ({ page }) => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/reviews")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/reviews$/);

  const heading = page.getByRole("heading", { name: "리뷰", exact: true, level: 1 });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(heading).toBeVisible();
    await page.screenshot({ path: `tests/e2e/screenshots/sa048-title-${width}.png` });
  }
});
