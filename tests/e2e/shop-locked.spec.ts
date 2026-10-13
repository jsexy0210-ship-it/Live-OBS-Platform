import { expect, test, type Page } from "@playwright/test";
import { setOperatingState } from "./cartDb";

// 보드 SH-041 v320: 잠금 화면(로그인 전 「로그인하기」 · 로그인 후 「주문 조회」「문의하기」).
// 잠금 상태를 직접 만들 수 없어 일시 정지 + 이용안내 주소(닫힘 화면에서도 열리는 주소)에서 잠금 화면 렌더링을 확인한다. 해당 페이지는 shopOpen=false일 때 ShopLocked를 그린다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterEach(async () => {
  await setOperatingState(SLUG, "OPEN");
});

async function shot(page: Page, name: string) {
  for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: `tests/e2e/screenshots/SH-041-${name}-${w}.png` });
  }
}

test("로그인 전: 로그인하기", async ({ page }) => {
  await setOperatingState(SLUG, "PAUSED");
  await page.goto(`/shop/${SLUG}/help`);
  const card = page.locator(".shop-locked");
  await expect(card.getByRole("heading", { name: "지금은 쇼핑몰을 이용할 수 없어요", level: 1 })).toBeVisible();
  await expect(card).toContainText("이미 주문한 내역은 확인할 수 있어요.");
  await expect(card.getByRole("link", { name: "로그인하기" })).toBeVisible();
  await expect(card.getByRole("link", { name: "문의하기" })).toHaveCount(0);
  await shot(page, "out");
});

test("로그인 후: 주문 조회 · 문의하기", async ({ page, baseURL }) => {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  await setOperatingState(SLUG, "PAUSED");
  await page.goto(`/shop/${SLUG}/help`);
  const card = page.locator(".shop-locked");
  await expect(card.getByRole("link", { name: "주문 조회" })).toBeVisible();
  await expect(card.getByRole("link", { name: "문의하기" })).toHaveAttribute("href", `/shop/${SLUG}/me/inquiries`);
  await expect(card.getByRole("link", { name: "로그인하기" })).toHaveCount(0);
  await shot(page, "in");
});
