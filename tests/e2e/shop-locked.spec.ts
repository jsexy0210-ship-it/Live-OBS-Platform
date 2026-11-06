import { expect, test, type Page } from "@playwright/test";
import { expireTrialInDb, restoreTrialEnd } from "./cartDb";

// 보드 SH-041 v320: 잠금 화면(로그인 전 「로그인하기」 · 로그인 후 「주문 조회」「문의하기」).
// 이용 기간이 끝난 쇼핑몰(체험 종료일이 지난 상태)의 홈에서 잠금 화면을 확인한다. 일시 정지는 별도의 「잠시 쉬고 있어요」 화면이고 이용안내는 닫힌 쇼핑몰에서도 열린다(#1100).
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
let prevTrialEnd: Date | null = null;
test.afterEach(async () => {
  await restoreTrialEnd(SLUG, prevTrialEnd);
});

async function shot(page: Page, name: string) {
  for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: `tests/e2e/screenshots/SH-041-${name}-${w}.png` });
  }
}

test("로그인 전: 로그인하기", async ({ page }) => {
  prevTrialEnd = await expireTrialInDb(SLUG);
  await page.goto(`/shop/${SLUG}`);
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
  prevTrialEnd = await expireTrialInDb(SLUG);
  await page.goto(`/shop/${SLUG}`);
  const card = page.locator(".shop-locked");
  await expect(card.getByRole("link", { name: "주문 조회" })).toBeVisible();
  await expect(card.getByRole("link", { name: "문의하기" })).toHaveAttribute("href", `/shop/${SLUG}/me/inquiries`);
  await expect(card.getByRole("link", { name: "로그인하기" })).toHaveCount(0);
  await shot(page, "in");
});
