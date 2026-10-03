import { expect, test, type Page } from "@playwright/test";

// 모든 화면 서체는 원티드 산스(대표님 지시 2026-10-03, 정본: docs/DESIGN_PROMPT.md 「디자인 판단 확정」).
// 가변 woff2를 저장소(public/fonts/wanted-sans)에서 내려주고, 외부 글꼴 CDN(Google Fonts)은 부르지 않는다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

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

// 화면 글자가 원티드 산스로 그려지는지: 계산된 서체 첫 번째가 원티드 산스이고, 실제로 내려받아 400·800 굵기를 쓸 수 있다
async function expectWantedSans(page: Page) {
  const r = await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([document.fonts.load('400 16px "Wanted Sans Variable"'), document.fonts.load('800 16px "Wanted Sans Variable"')]);
    const el = document.querySelector(".app") as HTMLElement;
    return {
      family: getComputedStyle(el).fontFamily,
      w400: document.fonts.check('400 16px "Wanted Sans Variable"'),
      w800: document.fonts.check('800 16px "Wanted Sans Variable"'),
      loaded: [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Wanted Sans Variable" && f.status === "loaded"),
    };
  });
  expect(r.family.startsWith('"Wanted Sans Variable"')).toBe(true);
  expect(r).toMatchObject({ w400: true, w800: true, loaded: true });
}

test("파트너스 로그인·주문 화면과 쇼핑몰 화면이 원티드 산스로 그려지고, 외부 글꼴 CDN을 부르지 않는다", async ({ page }) => {
  const external: string[] = [];
  const font: number[] = [];
  page.on("request", (r) => {
    if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) external.push(r.url());
  });
  page.on("response", (r) => {
    if (r.url().endsWith("/fonts/wanted-sans/WantedSansVariable.woff2")) font.push(r.status());
  });

  await page.goto("/seller/login");
  await expectWantedSans(page);
  await shot(page, "FONT-login");

  await page.getByLabel("이메일").fill("demo-owner@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.goto("/seller/orders");
  await expect(page.getByTestId("order-row").first()).toBeVisible();
  await expectWantedSans(page);
  await shot(page, "FONT-orders");

  // 쇼핑몰 화면은 지금 회원가입만 있다(운영 빌드는 본인확인 공급자가 없어 준비 중 상태로 보인다)
  await page.goto("/shop/demo-shop/signup");
  await expectWantedSans(page);
  await shot(page, "FONT-shop");

  expect(external).toEqual([]);
  expect(font.length).toBeGreaterThan(0);
  expect(font.every((s) => s === 200 || s === 304)).toBe(true);
});
