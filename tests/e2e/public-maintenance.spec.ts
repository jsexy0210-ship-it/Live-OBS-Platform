import { expect, test } from "@playwright/test";

// AU-010 점검 중: DB에서 상태를 읽지 못하면 점검 중 화면을 보여 준다.
test("/maintenance 화면이 열린다", async ({ page }) => {
  await page.goto("/maintenance");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("지금은 점검 중이에요");
  await expect(page.getByTestId("maintenance")).toContainText("결제가 끝난 주문은 점검이 끝난 뒤 주문 내역에서 확인할 수 있어요");
  await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
});
