import { expect, test, type Page } from "@playwright/test";

// 모든 화면 서체는 원티드 산스(대표님 지시 2026-10-03, 정본: docs/DESIGN_PROMPT.md 「디자인 판단 확정」).
// 글자 범위별 가변 woff2(unicode-range)를 저장소(public/fonts/wanted-sans/split)에서 내려주고, 외부 글꼴 CDN(Google Fonts)은 부르지 않는다.
// 첫 화면에서 받는 서체 용량 합계는 400KB 이하(휴대폰 첫 화면이 느려지지 않게, MASTER 결정 2026-10-03).
const FIRST_SCREEN_FONT_LIMIT = 400 * 1024;
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
async function expectWantedSans(page: Page, selector = ".app") {
  const r = await page.evaluate(async (sel) => {
    await document.fonts.ready;
    await Promise.all([document.fonts.load('400 16px "Wanted Sans Variable"'), document.fonts.load('800 16px "Wanted Sans Variable"')]);
    const el = document.querySelector(sel) as HTMLElement;
    return {
      family: getComputedStyle(el).fontFamily,
      w400: document.fonts.check('400 16px "Wanted Sans Variable"'),
      w800: document.fonts.check('800 16px "Wanted Sans Variable"'),
      loaded: [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Wanted Sans Variable" && f.status === "loaded"),
    };
  }, selector);
  expect(r.family.startsWith('"Wanted Sans Variable"')).toBe(true);
  expect(r).toMatchObject({ w400: true, w800: true, loaded: true });
}

test("파트너스 로그인·주문 화면, 쇼핑몰 화면, 루트(/)가 원티드 산스로 그려지고, 외부 글꼴 CDN을 부르지 않는다", async ({ page }) => {
  const external: string[] = [];
  const font: { url: string; status: number; size: Promise<number> }[] = [];
  page.on("request", (r) => {
    if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) external.push(r.url());
  });
  page.on("response", (r) => {
    if (r.url().includes("/fonts/wanted-sans/split/")) font.push({ url: r.url(), status: r.status(), size: r.body().then((b) => b.length, () => 0) });
  });

  await page.goto("/seller/login");
  await expectWantedSans(page);
  await page.waitForLoadState("networkidle");
  // 첫 화면(로그인)에서 받은 서체 파일 용량 합계
  const first = (await Promise.all(font.map((f) => f.size))).reduce((a, b) => a + b, 0);
  console.log(`첫 화면 서체: 파일 ${font.length}개, ${Math.round(first / 1024)}KB`);
  expect(font.length).toBeGreaterThan(0);
  expect(first).toBeLessThanOrEqual(FIRST_SCREEN_FONT_LIMIT);
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
  // 루트(/)는 로그인 화면으로 가며, 루트 레이아웃에서 같은 서체를 쓴다
  await page.goto("/");
  await expectWantedSans(page);

  expect(font.every((f) => f.status === 200 || f.status === 304)).toBe(true);
});
