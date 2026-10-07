import { expect, test } from "@playwright/test";

// PF-009 개인정보처리방침: 법률 문구 없이 준비 중 안내만 보인다(푸터 링크가 404가 되지 않게).
test("개인정보처리방침은 준비 중 안내를 보여 준다", async ({ page }) => {
  const res = await page.goto("/privacy");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("개인정보처리방침");
  await expect(page.getByTestId("privacy-pending")).toContainText("개인정보처리방침을 아직 준비 중이에요");
  await expect(page.getByTestId("privacy-pending")).toContainText("준비되면 이 페이지에서 바로 볼 수 있어요.");
});
