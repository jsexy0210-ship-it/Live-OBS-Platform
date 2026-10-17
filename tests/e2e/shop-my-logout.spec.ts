import { expect, test, type Page } from "@playwright/test";
import { okConfirm } from "./shopConfirm";

// 보드 SH-020-IA·SH-020-PC-IA: 내 정보 허브(휴대폰)·왼쪽 메뉴(PC) 「로그아웃」 → 확인 창 「로그아웃할까요?」, 로그아웃 뒤 쇼핑몰 홈. 실제 서버·DB.
const SLUG = "demo-shop";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = "tests/e2e/screenshots";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

test("휴대폰 390: 내 정보 허브 맨 아래 「로그아웃」 → 확인 창 → 취소하면 그대로, 로그아웃하면 쇼핑몰 홈", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/shop/${SLUG}/me`);
  const out = page.locator("main").getByRole("button", { name: "로그아웃" });
  await expect(out).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await out.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/sh020-logout-390.png`, fullPage: true });
  await out.click();
  const dlg = page.getByRole("dialog", { name: "로그아웃할까요?" });
  await expect(dlg).toContainText("이 기기에서 로그아웃돼요.");
  await page.screenshot({ path: `${SHOTS}/sh020-logout-confirm-390.png` });
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/me$`));
  await out.click();
  await okConfirm(page, "로그아웃");
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/?$`));
  await page.goto(`/shop/${SLUG}/me`);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("PC 1440: 왼쪽 메뉴 맨 아래 「로그아웃」도 같은 확인 창을 거쳐 쇼핑몰 홈으로", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/me/rewards`);
  const menu = page.getByRole("navigation", { name: "내 정보 메뉴" });
  const out = menu.getByRole("button", { name: "로그아웃" });
  await expect(out).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/sh020-logout-menu-1440.png` });
  await page.goto(`/shop/${SLUG}/me`);
  await page.screenshot({ path: `${SHOTS}/sh020-hub-1440.png`, fullPage: true });
  await page.goto(`/shop/${SLUG}/me/rewards`);
  await out.click();
  await expect(page.getByRole("dialog", { name: "로그아웃할까요?" })).toBeVisible();
  await okConfirm(page, "로그아웃");
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/?$`));
});

test("비회원 PC: 로그인 전 화면의 왼쪽 메뉴에는 「로그아웃」이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/me/rewards`);
  const menu = page.getByRole("navigation", { name: "내 정보 메뉴" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button", { name: "로그아웃" })).toHaveCount(0);
});
