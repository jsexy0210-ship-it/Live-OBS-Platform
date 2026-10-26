import { expect, test, type Page } from "@playwright/test";

// SH-011 구매자 회원가입 — 운영 빌드(next start) 기준. 운영처럼 본인확인 키(포트원)가 없으면
// 필수 약관 동의 뒤 본인확인 단계에서 준비 중 안내와 잠긴 폼을 보여 줘야 한다(API도 503으로 막는다).
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
  await expect(page.getByRole("heading", { name: "회원가입", exact: true })).toBeVisible();
  const next = page.getByRole("button", { name: "다음", exact: true });
  await expect(next).toBeDisabled();
  await page.getByLabel("이용약관 동의 (필수)").check();
  await page.getByLabel("개인정보 수집 · 이용 동의 (필수)").check();
  await page.getByLabel("만 14세 이상이에요 (필수)").check();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/signup/verify$`));
  await expect(page.getByRole("heading", { name: "회원가입", exact: true })).toBeVisible();
  await expect(page.getByText("지금은 가입할 수 없어요.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "지금은 가입할 수 없어요." })).toHaveText("지금은 가입할 수 없어요. 휴대폰 본인확인 서비스를 준비하고 있어요. 준비되면 알려 드릴게요.");
  await expect(page.locator(".shop-name")).toHaveText("카드숍 별빛");
  const form = page.getByRole("form", { name: "본인확인", exact: true });
  await expect(form).toBeVisible();
  for (const id of ["idv-name", "idv-birth", "idv-phone", "idv-carrier", "idv-agree"]) {
    await expect(form.locator(`#${id}`)).toBeVisible();
    await expect(form.locator(`#${id}`)).toBeDisabled();
  }
  await expect(form.getByRole("button", { name: "인증번호 문자 받기", exact: true })).toBeDisabled();
  await expect(form.locator("input:not([disabled]), select:not([disabled]), button:not([disabled])")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "인증번호 확인하기", exact: true })).toHaveCount(0);
  await shot(page, "SH-011-unavailable");
});

test("없는 쇼핑몰 주소는 해요체 404 화면을 보여 준다", async ({ page }) => {
  const res = await page.goto("/shop/no-such-shop-e2e/signup");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "이런 쇼핑몰은 없어요" })).toBeVisible();
});
