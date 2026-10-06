import { expect, test } from "@playwright/test";

// 보드 SH-012 v298: 비밀번호 찾기(이메일 → 재설정 메일 보내기 → 「보냄」) · 새 비밀번호 설정 · 링크 만료. 「가입 안 된 이메일」 상태는 서버가 숨겨 만들지 않는다.
// 서버(#782)는 가짜 응답으로 대신해 화면 쪽만 확인한다.
const SLUG = "demo-shop";

test("로그인 화면의 「비밀번호를 잊었어요」가 비밀번호 찾기로 이어지고, 메일 요청 뒤 보냄 상태를 보여 준다", async ({ page }) => {
  let sent: unknown = null;
  await page.route(`**/api/shop/${SLUG}/auth/password-reset/request`, async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.goto(`/shop/${SLUG}/login`);
  await page.getByRole("link", { name: "비밀번호를 잊었어요" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/password-reset$`));
  const card = page.locator(".shop-login");
  await expect(card.getByRole("heading", { name: "비밀번호 찾기", level: 1 })).toBeVisible();
  await expect(card).toContainText("가입한 이메일로 재설정 링크를 보내 드려요 · 링크는 30분 동안 쓸 수 있어요");
  await page.screenshot({ path: "tests/e2e/screenshots/SH-012-request-1440.png" });
  await card.getByLabel("이메일").fill("starlight@example.com");
  await card.getByRole("button", { name: "재설정 메일 보내기" }).click();
  await expect(page.getByRole("heading", { name: "메일을 보냈어요." })).toBeVisible();
  await expect(page.locator(".shop-login")).toContainText("sta****@example.com · 링크는 30분 동안 쓸 수 있어요 · 메일이 없으면 스팸함을 확인해 주세요");
  expect(sent).toEqual({ loginId: "starlight@example.com" });
});

test("요청 실패: 너무 자주(429)·메일 못 보냄(503) 문구", async ({ page }) => {
  let status = 429;
  await page.route(`**/api/shop/${SLUG}/auth/password-reset/request`, (route) => route.fulfill({ status, json: { error: "x" } }));
  await page.goto(`/shop/${SLUG}/password-reset`);
  await page.getByLabel("이메일").fill("a@example.com");
  await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
  await expect(page.locator(".shop-login [role=alert]")).toHaveText("너무 자주 요청했어요. 잠시 뒤 다시 해 주세요.");
  status = 503;
  await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
  await expect(page.locator(".shop-login [role=alert]")).toHaveText("메일을 보내지 못했어요. 잠시 뒤 다시 해 주세요.");
});

test("메일 링크: 새 비밀번호 설정 → 바꾸면 로그인으로(자동 로그인 없음)", async ({ page }) => {
  let body: unknown = null;
  await page.route(`**/api/shop/${SLUG}/auth/password-reset/confirm`, async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.goto(`/shop/${SLUG}/password-reset?token=abc123`);
  const form = page.locator("form.shop-login");
  await expect(form.getByRole("heading", { name: "새 비밀번호 설정" })).toBeVisible();
  await expect(form).toContainText("8자 이상");
  await form.getByLabel("새 비밀번호", { exact: true }).fill("short");
  await form.getByLabel("새 비밀번호 확인").fill("short");
  await form.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.locator(".shop-login [role=alert]")).toHaveText("비밀번호는 8자 이상으로 입력해 주세요.");
  await form.getByLabel("새 비밀번호", { exact: true }).fill("longenough1");
  await form.getByLabel("새 비밀번호 확인").fill("different12");
  await form.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.locator(".shop-login [role=alert]")).toHaveText("비밀번호가 서로 달라요.");
  await form.getByLabel("새 비밀번호 확인").fill("longenough1");
  await form.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.getByRole("heading", { name: "비밀번호를 바꿨어요" })).toBeVisible();
  expect(body).toEqual({ token: "abc123", password: "longenough1" });
  await expect(page.getByRole("link", { name: "로그인하기" })).toHaveAttribute("href", `/shop/${SLUG}/login`);
});

test("링크 만료(410): 만료 안내 → 다시 보내기로 요청 화면", async ({ page }) => {
  await page.route(`**/api/shop/${SLUG}/auth/password-reset/confirm`, (route) => route.fulfill({ status: 410, json: { error: "token_expired" } }));
  await page.goto(`/shop/${SLUG}/password-reset?token=old`);
  await page.getByLabel("새 비밀번호", { exact: true }).fill("longenough1");
  await page.getByLabel("새 비밀번호 확인").fill("longenough1");
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.locator("section.shop-login[role=alert]")).toContainText("링크가 만료됐어요 (30분 지남) · 다시 요청해 주세요");
  await page.getByRole("button", { name: "다시 보내기" }).click();
  await expect(page.getByRole("button", { name: "재설정 메일 보내기" })).toBeVisible();
});

test("휴대폰 390: 가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/shop/${SLUG}/password-reset`);
  await expect(page.getByRole("heading", { name: "비밀번호 찾기", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-012-request-390.png" });
});

// 가짜 응답이 아니라 실제 서버(#782): 없는 토큰은 400 token_invalid → 「이 링크는 쓸 수 없어요」
test("실제 서버: 쓸 수 없는 링크는 안내 문구", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/password-reset?token=not-a-real-token`);
  await page.getByLabel("새 비밀번호", { exact: true }).fill("longenough1");
  await page.getByLabel("새 비밀번호 확인").fill("longenough1");
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(page.locator(".shop-login [role=alert]")).toHaveText("이 링크는 쓸 수 없어요. 재설정 메일을 다시 받아 주세요.");
});
