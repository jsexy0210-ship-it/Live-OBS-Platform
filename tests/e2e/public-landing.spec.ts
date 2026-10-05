import { expect, test } from "@playwright/test";

// 루트(/)는 서비스 소개(PF-001)다. 로그인·가입 진입이 보인다.
test("루트 접속은 서비스 소개가 열리고 로그인·가입 진입이 있다", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("방송 화면에 줄이 서요");
  await page.getByRole("link", { name: "로그인" }).first().click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await expect(page.locator(".login-card")).toBeVisible();
});

test("서비스 소개의 가입 신청은 파트너스 가입으로 간다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "파트너스 가입 신청" }).first().click();
  await expect(page).toHaveURL(/\/seller\/signup/);
});
