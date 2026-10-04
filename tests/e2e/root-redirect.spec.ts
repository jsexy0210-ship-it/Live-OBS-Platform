import { expect, test } from "@playwright/test";

// 첫 화면은 로그인이다: 루트(/) 접속은 파트너스 로그인으로 이동한다
test("루트 접속은 /seller/login으로 가고 로그인 폼이 보인다", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/seller\/login$/);
  await expect(page.locator(".login-card")).toBeVisible();
  await expect(page.getByLabel("비밀번호")).toBeVisible();
});
