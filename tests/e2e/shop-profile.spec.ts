import { expect, test, type Page } from "@playwright/test";
import { nicknameInDb, resetNicknameInDb } from "./profileDb";

// 보드 SH-024-IA: 회원정보 수정(읽기 전용 줄 · 닉네임 변경 · 30일 제한 · 비밀번호 바꾸기 · 알림 수신 · 탈퇴 확인 창). 실제 서버·DB.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const TEMP = "Tmp-e2e-1234a";
let original = "";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  original = await nicknameInDb(SLUG, LOGIN);
  await resetNicknameInDb(SLUG, LOGIN, original, null);
});
test.afterAll(() => resetNicknameInDb(SLUG, LOGIN, original, null));

async function login(page: Page, baseURL: string, password = PASSWORD) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

test("비회원: 로그인 안내", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/me/profile`);
  await expect(page.getByRole("heading", { name: "회원정보 수정", level: 1 })).toBeVisible();
  await expect(page.getByText("로그인하면 볼 수 있어요")).toBeVisible();
});

test("PC: 읽기 전용 줄 · 닉네임 바꾸기 → 30일 제한 안내, 메뉴로 도달", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/me`);
  await page.getByRole("navigation", { name: "내 정보" }).getByRole("link", { name: "회원정보 수정" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/me/profile$`));
  const rows = page.locator(".pf-rows");
  await expect(rows).toContainText(LOGIN);
  await expect(rows).toContainText("바꿀 수 없어요");
  await expect(rows).toContainText("010-");
  await expect(rows.getByRole("button", { name: "번호 바꾸기 (본인확인)" })).toBeDisabled();
  await expect(page.getByLabel(/^방송 닉네임/)).toHaveValue(original);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-024-profile-1440.png", fullPage: true });
  await page.getByLabel(/^방송 닉네임/).fill("e2e별빛이");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("회원정보를 저장했어요")).toBeVisible();
  await expect(page.getByText(/닉네임은 30일에 1번만 바꿀 수 있어요 · 다음 변경/)).toBeVisible();
  await expect(page.getByLabel(/^방송 닉네임/)).toBeDisabled();
  expect(await nicknameInDb(SLUG, LOGIN)).toBe("e2e별빛이");
  await resetNicknameInDb(SLUG, LOGIN, original, null);
});

test("비밀번호 바꾸기: 입력 검사 · 현재 비밀번호 틀림 · 바꾼 뒤 새 비밀번호로 로그인, 원래대로 되돌림", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.goto(`/shop/${SLUG}/me/profile`);
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  const dlg = page.getByRole("dialog", { name: "비밀번호 바꾸기" });
  await dlg.getByLabel("현재 비밀번호").fill("wrong-password-1");
  await dlg.getByLabel("새 비밀번호", { exact: true }).fill("short");
  await dlg.getByLabel("새 비밀번호 확인").fill("short");
  await dlg.getByRole("button", { name: "바꾸기" }).click();
  await expect(dlg.getByText("영문과 숫자를 섞어 8자 이상")).toBeVisible();
  await dlg.getByLabel("새 비밀번호", { exact: true }).fill(TEMP);
  await dlg.getByLabel("새 비밀번호 확인").fill(`${TEMP}x`);
  await dlg.getByRole("button", { name: "바꾸기" }).click();
  await expect(dlg.getByText("서로 달라요")).toBeVisible();
  await dlg.getByLabel("새 비밀번호 확인").fill(TEMP);
  await dlg.getByRole("button", { name: "바꾸기" }).click();
  await expect(dlg.getByText("현재 비밀번호가 맞지 않아요")).toBeVisible();
  await dlg.getByLabel("현재 비밀번호").fill(PASSWORD);
  await dlg.getByRole("button", { name: "바꾸기" }).click();
  await expect(page.getByText("비밀번호를 바꿨어요")).toBeVisible();
  // 새 비밀번호로 로그인되고, 다시 원래 비밀번호로 되돌린다
  await login(page, baseURL!, TEMP);
  await page.goto(`/shop/${SLUG}/me/profile`);
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  const back = page.getByRole("dialog", { name: "비밀번호 바꾸기" });
  await back.getByLabel("현재 비밀번호").fill(TEMP);
  await back.getByLabel("새 비밀번호", { exact: true }).fill(PASSWORD);
  await back.getByLabel("새 비밀번호 확인").fill(PASSWORD);
  await back.getByRole("button", { name: "바꾸기" }).click();
  await expect(page.getByText("비밀번호를 바꿨어요")).toBeVisible();
  await login(page, baseURL!);
});

test("탈퇴 확인 창: 열고 닫기만(실제 탈퇴는 하지 않음)", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.goto(`/shop/${SLUG}/me/profile`);
  await page.getByRole("button", { name: "회원 탈퇴" }).click();
  const dlg = page.getByRole("dialog", { name: "정말 탈퇴하시겠어요?" });
  await expect(dlg).toContainText("되돌릴 수 없어요");
  await expect(dlg.getByRole("button", { name: "탈퇴하기" })).toBeDisabled();
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(dlg).toBeHidden();
});

for (const vp of [
  { name: "1024", w: 1024, h: 800 },
  { name: "390", w: 390, h: 844 },
]) {
  test(`${vp.name}: 회원정보 수정 화면`, async ({ page, baseURL }) => {
    await login(page, baseURL!);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(`/shop/${SLUG}/me/profile`);
    await expect(page.getByLabel(/^방송 닉네임/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `tests/e2e/screenshots/SH-024-profile-${vp.name}.png`, fullPage: true });
  });
}
