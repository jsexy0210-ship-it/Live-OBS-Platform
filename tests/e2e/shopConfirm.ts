import type { Page } from "@playwright/test";

// 구매자 확인 창(DS-CONFIRM 구매자)에서 실행 버튼을 누른다. 실행 이름은 「확인」이 아니라 행동 그대로다.
export async function okConfirm(page: Page, label: string) {
  await page.locator(".confirm-dialog").getByRole("button", { name: label, exact: true }).click();
}
