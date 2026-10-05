import { expect, test } from "@playwright/test";

// AU-010 점검 중. DB를 못 읽거나 점검이 켜져 있으면 점검 중 화면, 점검이 꺼져 있으면 「점검이 끝났어요」가 보인다.
test("/maintenance 화면이 상태에 맞게 열린다", async ({ page }) => {
  await page.goto("/maintenance");
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText(/^(지금은 점검 중이에요|점검이 끝났어요)$/);
  if ((await title.textContent()) === "지금은 점검 중이에요") {
    await expect(page.getByTestId("maintenance")).toContainText("결제가 끝난 주문은 점검이 끝난 뒤 주문 내역에서 확인할 수 있어요");
    await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
  } else {
    await expect(page.getByRole("link", { name: "처음으로" })).toBeVisible();
  }
});

// 점검을 켠 시험 DB에서만(E2E_MAINTENANCE_ON=1): 쇼핑몰 주소가 그대로인 채 점검 화면이 보인다(proxy).
test("점검 중에는 쇼핑몰 주소에서도 점검 화면이 보인다", async ({ page }) => {
  test.skip(!process.env.E2E_MAINTENANCE_ON, "점검을 켠 시험 DB에서만 실행");
  await page.goto("/shop/none");
  await expect(page).toHaveURL(/\/shop\/none$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("지금은 점검 중이에요");
  await expect(page.getByTestId("maintenance-message")).not.toBeEmpty();
});
