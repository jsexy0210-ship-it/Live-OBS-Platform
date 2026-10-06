import { expect, test } from "@playwright/test";

// 테스트 모드 서버(OBS_TEST_MODE=1)에서 /api/health를 가로채지 않고 실제 응답으로 안내가 보이는지 확인한다(playwright.config.ts 「testmode」).
const NOTICE = "테스트 모드입니다. 인증번호 000000을 입력해 주십시오.";

for (const path of ["/seller/signup", "/seller/password-reset"]) {
  test(`테스트 모드 서버: ${path} 본인확인 단계에 실제 health 응답으로 안내가 보인다`, async ({ page }) => {
    let health = page.waitForResponse((r) => r.url().endsWith("/api/health"));
    await page.goto(path);
    if (path === "/seller/signup") {
      // 가입 신청은 약관 동의(1/5) 뒤 본인확인(2/5) 단계에서 안내가 보인다
      await page.getByLabel("모두 동의해요", { exact: true }).check();
      health = page.waitForResponse((r) => r.url().endsWith("/api/health"));
      await page.getByRole("button", { name: "다음", exact: true }).click();
      await expect(page).toHaveURL(/\/seller\/signup\/verify$/);
    }
    expect(((await (await health).json()) as { testMode?: boolean }).testMode).toBe(true);
    await expect(page.getByTestId("test-mode-notice")).toHaveText(NOTICE);
  });
}
