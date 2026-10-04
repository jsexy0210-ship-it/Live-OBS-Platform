import { expect, test, type Page } from "@playwright/test";

// 테스트 서버 모드 안내(대표님 지시 2026-10-03). 서버가 OBS_TEST_MODE=1이면 GET /api/health에 testMode: true가 붙고,
// 본인확인 단계에 「테스트 모드입니다. 인증번호 000000을 입력해 주십시오.」가 보인다. 운영(값 없음)에서는 보이지 않는다.
// 이 e2e 서버는 테스트 모드가 아니라서, 켜진 경우는 /api/health 응답을 testMode: true로 바꿔 확인한다.
// 구매자 가입(SH-011)은 운영 빌드에서 본인확인 공급자가 없으면 폼 대신 준비 중 화면이라 개발 서버(test-mode-flow.spec.ts)에서 확인한다.
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const NOTICE = "테스트 모드입니다. 인증번호 000000을 입력해 주십시오.";
const PAGES = ["/seller/signup", "/seller/password-reset"];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function open(page: Page, path: string) {
  const health = page.waitForResponse((r) => r.url().endsWith("/api/health"));
  await page.goto(path);
  return (await health).json() as Promise<{ testMode?: boolean }>;
}

test("운영(테스트 모드 값 없음)에서는 파트너스 가입·비밀번호 찾기 본인확인에 테스트 모드 안내가 없다", async ({ page }) => {
  for (const path of PAGES) {
    const health = await open(page, path);
    expect(health.testMode).toBeUndefined();
    await expect(page.getByLabel("휴대폰번호", { exact: true })).toBeVisible();
    await expect(page.getByTestId("test-mode-notice")).toHaveCount(0);
    await expect(page.getByText(NOTICE)).toHaveCount(0);
  }
});

test("테스트 모드면 파트너스 가입·비밀번호 찾기 본인확인 단계에 인증번호 000000 안내가 보인다", async ({ page }) => {
  await page.route("**/api/health", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), testMode: true } });
  });
  for (const [i, path] of PAGES.entries()) {
    await open(page, path);
    await expect(page.getByTestId("test-mode-notice")).toHaveText(NOTICE);
    await shot(page, ["PF-007-1-testmode", "AU-003-testmode"][i]);
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("파트너스 로그인 아이디 칸은 이메일 형식이 아닌 시험 계정(test)을 넣어도 형식 오류로 표시하지 않는다", async ({ page }) => {
  await page.goto("/seller/login");
  const id = page.getByLabel("이메일");
  await id.fill("test");
  await expect(id).toHaveAttribute("type", "text");
  await expect(id).toHaveAttribute("autocomplete", "username");
  expect(await id.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true);
  // 비밀번호 찾기 이메일 칸도 같다
  await page.goto("/seller/password-reset");
  const reset = page.getByLabel("이메일");
  await reset.fill("test");
  expect(await reset.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true);
});
