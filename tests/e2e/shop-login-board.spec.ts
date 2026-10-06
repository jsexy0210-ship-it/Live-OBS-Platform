import { expect, test } from "@playwright/test";

// 보드 SH-010 v298: 부제 「{쇼핑몰} 회원으로 들어가요」 · 이메일 · 비밀번호 · 로그인 유지(기본 꺼짐) · 로그인 · 「아직 회원이 아니에요? 회원가입」.
// 로그인 유지: 끄면 세션 쿠키(만료일 없음), 켜면 약 30일 쿠키. 비회원 주문 진입은 없다(회원만 주문).
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

test("로그인 화면 구성: 부제·이메일·비밀번호·로그인 유지(꺼짐)·회원가입 안내, 비회원 주문 없음", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/login`);
  const form = page.locator("form.shop-login");
  await expect(form.getByRole("heading", { name: "로그인", level: 1 })).toBeVisible();
  await expect(form).toContainText("카드숍 별빛 회원으로 들어가요");
  await expect(form.getByLabel("이메일")).toBeVisible();
  await expect(form.getByLabel("비밀번호")).toBeVisible();
  await expect(form.getByRole("checkbox", { name: "로그인 유지" })).not.toBeChecked();
  await expect(form).toContainText("아직 회원이 아니에요?");
  await expect(form.getByRole("link", { name: "회원가입" })).toHaveAttribute("href", `/shop/${SLUG}/signup`);
  await expect(page.getByText("비회원으로 주문하기")).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-010-login-1440.png" });
});

test("틀린 비밀번호는 서버 문구를 그대로 보여 주고 로그인 유지 값은 요청에 실린다", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/login`);
  let sent: unknown = null;
  await page.route("**/api/shop/*/auth/login", (route) => {
    sent = route.request().postDataJSON();
    return route.continue();
  });
  await page.getByLabel("이메일").fill(LOGIN);
  await page.getByLabel("비밀번호").fill("틀린-비밀번호-1");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(sent).toMatchObject({ loginId: LOGIN, remember: false });
  await page.getByRole("checkbox", { name: "로그인 유지" }).check();
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect.poll(() => (sent as { remember?: boolean } | null)?.remember).toBe(true);
});

test("로그인 유지를 끄면 세션 쿠키, 켜면 약 30일 쿠키로 로그인된다", async ({ page, context }) => {
  const cookieOf = async () => (await context.cookies()).find((c) => c.name.toLowerCase().includes("buyer"));
  // 끔(기본)
  await page.goto(`/shop/${SLUG}/login`);
  await page.getByLabel("이메일").fill(LOGIN);
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}$`));
  const off = await cookieOf();
  expect(off).toBeTruthy();
  expect(off!.expires).toBe(-1); // 브라우저를 닫으면 끝나는 세션 쿠키
  await context.clearCookies();
  // 켬
  await page.goto(`/shop/${SLUG}/login`);
  await page.getByLabel("이메일").fill(LOGIN);
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("checkbox", { name: "로그인 유지" }).check();
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}$`));
  const on = await cookieOf();
  expect(on).toBeTruthy();
  const days = (on!.expires - Date.now() / 1000) / 86400;
  expect(days).toBeGreaterThan(29);
  expect(days).toBeLessThanOrEqual(30.1);
});

test("휴대폰 390: 로그인 화면 가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/shop/${SLUG}/login`);
  await expect(page.locator("form.shop-login")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-010-login-390.png" });
});
