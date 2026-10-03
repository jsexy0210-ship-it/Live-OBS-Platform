import { expect, test, type Page } from "@playwright/test";

// 구매자 가입(SH-011) 본인확인 단계의 테스트 모드 안내. 개발 서버(playwright.config.ts 「dev」, 가짜 본인확인 공급자)에서 폼이 보인다.
// 개발 서버도 테스트 서버 모드(OBS_TEST_MODE=1)는 아니라서, 켜진 경우는 /api/health 응답을 testMode: true로 바꿔 확인한다.
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const NOTICE = "테스트 모드예요. 인증번호 000000을 입력하세요";

async function open(page: Page) {
  const health = page.waitForResponse((r) => r.url().endsWith("/api/health"));
  await page.goto("/shop/demo-shop/signup");
  return (await health).json() as Promise<{ testMode?: boolean }>;
}

test("구매자 가입: 테스트 모드 값이 없으면 안내가 없고, 테스트 모드면 본인확인 단계에 인증번호 000000 안내가 보인다", async ({ page }) => {
  expect((await open(page)).testMode).toBeUndefined();
  await expect(page.getByLabel("휴대폰번호", { exact: true })).toBeVisible();
  await expect(page.getByTestId("test-mode-notice")).toHaveCount(0);

  await page.route("**/api/health", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), testMode: true } });
  });
  await open(page);
  await expect(page.getByTestId("test-mode-notice")).toHaveText(NOTICE);
  if (SHOTS) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `tests/e2e/screenshots/SH-011-testmode-${width}.png`, fullPage: true });
    }
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
