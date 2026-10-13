import { expect, test, type Page } from "@playwright/test";

// SH-011 구매자 회원가입 — 운영 빌드(next start) 기준. 운영처럼 본인확인 키(포트원)가 없으면
// 입력 칸을 보여 주지 않고 「본인확인 서비스 준비 중이에요」 상태 화면을 보여 줘야 한다(API도 503으로 막는다).
// 가입 흐름은 shop-signup-flow.spec.ts(개발 서버)에서 확인한다.
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const SLUG = "demo-shop";

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

test("본인확인 키가 없으면 가입 대신 준비 중 상태 화면을 보여 준다", async ({ page, request, baseURL }) => {
  // 서버가 정말 503으로 막는 환경인지 먼저 확인(키가 있는 환경이면 이 테스트의 전제가 틀린 것)
  const api = await request.post(`/api/shop/${SLUG}/signup/verification`, {
    data: { name: "확인", phone: "01012345678", birth7: "9901011", carrier: "SKT" },
    headers: { origin: new URL(baseURL!).origin },
  });
  expect(api.status()).toBe(503);
  expect((await api.json()).message).toBe("본인확인 서비스 준비 중이에요");

  const res = await page.goto(`/shop/${SLUG}/signup`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "본인확인 서비스 준비 중이에요" })).toBeVisible();
  await expect(page.locator(".shop-name")).toHaveText("카드숍 별빛");
  // 입력해 봐야 소용없는 칸·버튼은 보이지 않는다
  await expect(page.getByLabel("이름")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "인증번호 받기" })).toHaveCount(0);
  await shot(page, "SH-011-unavailable");
});

test("없는 쇼핑몰 주소는 해요체 404 화면을 보여 준다", async ({ page }) => {
  const res = await page.goto("/shop/no-such-shop-e2e/signup");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "이런 쇼핑몰은 없어요" })).toBeVisible();
});
