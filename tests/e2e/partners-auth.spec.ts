import { expect, test, type Page } from "@playwright/test";

// 파트너스 로그인(AU-002) 문구·링크와, 본인확인 대행사 연결 전(운영 빌드, 본인확인 키 없음 → API 503) 가입 신청(PF-007)·비밀번호 찾기(AU-003) 상태 화면.
// 본인확인이 실제로 도는 흐름은 개발 서버에서 partners-auth-flow.spec.ts가 확인한다.
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

async function fillIdentity(page: Page) {
  await page.getByLabel("이름", { exact: true }).fill("김별빛");
  await page.getByLabel("생년월일").fill("19900101");
  await page.getByRole("button", { name: "남", exact: true }).click();
  await page.getByLabel("통신사").selectOption("SKT");
  await page.getByLabel("휴대폰번호", { exact: true }).fill("01012345678");
  await page.getByLabel(agreeLabel(page)).check();
}
// 본인확인 약관 동의 문구: 가입 신청(공개 화면)은 해요체, 관리자 인증 화면은 합니다체
const agreeLabel = (page: Page) => (new URL(page.url()).pathname.startsWith("/seller/signup") ? "본인확인 이용 약관에 모두 동의해요" : "본인확인 이용 약관에 모두 동의합니다");

// 화면에 보이는 글에 「판매자」가 없어야 한다(화면 문구는 「파트너스」, 대표님 지시 2026-10-04)
async function noSellerWord(page: Page) {
  expect(await page.locator("body").innerText()).not.toContain("판매자");
}

test("파트너스 로그인: 제목·설명이 파트너스 관리자이고, 회원가입·비밀번호 찾기로 이동한다", async ({ page }) => {
  await page.goto("/seller/login");
  await expect(page.getByRole("heading", { name: "파트너스 관리자" })).toBeVisible();
  await expect(page.getByText("라이브 방송과 주문을 한곳에서 관리합니다")).toBeVisible();
  await noSellerWord(page);
  await shot(page, "AU-002");
  await page.getByRole("link", { name: "회원가입" }).click();
  await expect(page).toHaveURL(/\/seller\/signup$/);
  await expect(page.getByRole("heading", { name: "파트너스 가입 신청" })).toBeVisible();
  await expect(page.getByRole("list", { name: "진행 단계" })).toContainText("본인확인");
  await noSellerWord(page);
  await page.goto("/seller/login");
  await page.getByRole("link", { name: "아이디/비밀번호 찾기" }).click();
  await page.getByRole("link", { name: "비밀번호 찾기", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/password-reset$/);
  await expect(page.getByRole("heading", { name: "비밀번호 찾기" })).toBeVisible();
  await expect(page.getByText("쇼핑몰 대표자 본인 명의의 휴대폰으로 확인합니다.")).toBeVisible();
  await noSellerWord(page);
});

test("가입 신청: 본인확인 대행사 연결 전이면 인증번호 받기에서 「본인확인 서비스 준비 중이에요」 화면으로 바뀐다", async ({ page }) => {
  await page.goto("/seller/signup");
  // 필수 약관(PF-007-1)에 동의하고 본인확인 단계(2/5)로 간다
  await page.getByLabel("모두 동의해요", { exact: true }).check();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/signup\/verify$/);
  await fillIdentity(page);
  const res = page.waitForResponse((r) => r.url().endsWith("/api/seller-signup/verification") && r.request().method() === "POST");
  await page.getByRole("button", { name: "인증번호 문자 받기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "문자 받기" }).click();
  expect((await res).status()).toBe(503);
  await expect(page.getByRole("heading", { name: "본인확인 서비스 준비 중이에요" })).toBeVisible();
  await expect(page.getByText("준비되면 바로 가입을 신청할 수 있어요.")).toBeVisible();
  await noSellerWord(page);
  await shot(page, "PF-007-unavailable");
  await page.getByRole("link", { name: "로그인으로 돌아가기" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
});

test("비밀번호 찾기: 이메일·쇼핑몰 주소를 적어야 인증번호를 받을 수 있고, 연결 전이면 준비 중 화면으로 바뀐다", async ({ page }) => {
  await page.goto("/seller/password-reset");
  await fillIdentity(page);
  const send = page.getByRole("button", { name: "인증번호 문자 받기" });
  await expect(send).toBeDisabled();
  await page.getByLabel("이메일").fill("demo-owner@example.com");
  await page.getByLabel("쇼핑몰 주소").fill("demo-shop");
  await expect(send).toBeEnabled();
  await shot(page, "AU-003");
  const res = page.waitForResponse((r) => r.url().endsWith("/api/seller/password-reset/start"));
  await send.click();
  await page.getByRole("dialog").getByRole("button", { name: "문자 받기" }).click();
  expect((await res).status()).toBe(503);
  await expect(page.getByRole("heading", { name: "본인 확인 서비스를 준비하는 중입니다" })).toBeVisible();
  await expect(page.getByText("준비가 끝나면 바로 비밀번호를 찾을 수 있습니다.")).toBeVisible();
  await noSellerWord(page);
  await shot(page, "AU-003-unavailable");
});
