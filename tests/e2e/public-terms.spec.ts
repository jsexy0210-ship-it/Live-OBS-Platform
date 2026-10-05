import { expect, test } from "@playwright/test";

// PF-008 이용약관: 서식(docs/terms/SELLER_TERMS_TEMPLATE.md)의 조문이 보이고, 빈 값이 있으면 시행 전 초안으로 표시된다.
test("이용약관이 열리고 목차로 조문에 이동하며 초안 표시가 있다", async ({ page }) => {
  await page.goto("/terms");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("이용약관");
  await expect(page.getByRole("heading", { name: "제9조(책임의 제한)" })).toBeVisible();
  await expect(page.getByTestId("terms-draft")).toContainText("시행 전 초안");
  await expect(page.getByText("{{")).toHaveCount(0);
  await expect(page.getByText("정해지는 대로 알려 드려요").first()).toBeVisible();
  await page.getByRole("navigation", { name: "목차" }).getByRole("link", { name: "제12조(준거법과 관할)" }).click();
  await expect(page).toHaveURL(/#s11$/);
});
