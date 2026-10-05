import { expect, test } from "@playwright/test";

// /about은 서비스 소개(PF-001)다(루트 /는 로그인 이동 유지, 대표님 지시 2026-10-04). 로그인·가입 진입이 보인다.
test("/about은 서비스 소개가 열리고 로그인·가입 진입이 있다", async ({ page }) => {
  await page.goto("/about");
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("방송 화면에 줄이 서요");
  await page.getByRole("link", { name: "로그인" }).first().click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await expect(page.locator(".login-card")).toBeVisible();
});

test("서비스 소개의 가입 신청은 파트너스 가입으로 간다", async ({ page }) => {
  await page.goto("/about");
  await page.getByRole("link", { name: "파트너스 가입 신청" }).first().click();
  await expect(page).toHaveURL(/\/seller\/signup/);
});
