import { expect, test, type Page } from "@playwright/test";
import { clearRewardLedgerInDb, seedRewardLedgerInDb } from "./rewardDb";

// 보드 SH-023-IA: 내 적립금(카드 3개 · 탭 · 표 · 로그인 필요 · 빈 상태 · 지급 대기). 실제 서버·DB.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(() => clearRewardLedgerInDb(SLUG, LOGIN));

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
const rows = (page: Page) => page.locator(".rw-tbl tbody tr");

test("비회원: 로그인 안내", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/me/rewards`);
  await expect(page.getByRole("heading", { name: "내 적립금", level: 1 })).toBeVisible();
  await expect(page.getByText("로그인하면 볼 수 있어요")).toBeVisible();
});

test("PC: 카드·탭별 내역·금액 부호, 메뉴로 들어와 지급 대기 안내", async ({ page, baseURL }) => {
  await seedRewardLedgerInDb(SLUG, LOGIN, { payout: false });
  await login(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/me`);
  await page.getByRole("navigation", { name: "혜택" }).getByRole("link", { name: "내 적립금" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/me/rewards$`));
  const cards = page.locator(".rw-cards");
  await expect(cards).toContainText("쓸 수 있는 적립금");
  await expect(cards).toContainText("32,400원");
  await expect(cards).toContainText("이 쇼핑몰에서만 써요");
  await expect(cards).toContainText("적립 예정");
  await expect(cards).toContainText("곧 소멸");
  await expect(page.getByText("판매자가 적립금 지급을 아직 켜지 않았어요")).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).first()).toContainText("주문에 사용");
  await expect(rows(page).first()).toContainText("−10,000원");
  await expect(rows(page).filter({ hasText: "명예의 전당 1위 보너스" })).toContainText("+5,000원");
  await expect(rows(page).filter({ hasText: "주문 취소로 회수" })).toContainText("−760원");
  await page.screenshot({ path: "tests/e2e/screenshots/SH-023-rewards-1440.png", fullPage: true });
  const tabs = page.getByRole("tablist", { name: "적립금 내역 종류" });
  await tabs.getByRole("tab", { name: "적립" }).click();
  await expect(rows(page)).toHaveCount(2);
  await tabs.getByRole("tab", { name: "사용" }).click();
  await expect(rows(page)).toHaveCount(1);
  await tabs.getByRole("tab", { name: "소멸" }).click();
  await expect(page.getByRole("heading", { name: "내역이 없어요" })).toBeVisible();
});

test("지급이 켜져 있으면 지급 대기 안내가 없다", async ({ page, baseURL }) => {
  await seedRewardLedgerInDb(SLUG, LOGIN, { payout: true });
  await login(page, baseURL!);
  await page.goto(`/shop/${SLUG}/me/rewards`);
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByText("판매자가 적립금 지급을 아직 켜지 않았어요")).toHaveCount(0);
});

test("빈 상태", async ({ page, baseURL }) => {
  await clearRewardLedgerInDb(SLUG, LOGIN);
  await login(page, baseURL!);
  await page.goto(`/shop/${SLUG}/me/rewards`);
  await expect(page.getByRole("heading", { name: "아직 적립금이 없어요" })).toBeVisible();
  await expect(page.getByText("주문한 상품이 개봉되면 적립금이 쌓여요")).toBeVisible();
});

for (const vp of [
  { name: "1024", w: 1024, h: 800 },
  { name: "390", w: 390, h: 844 },
]) {
  test(`${vp.name}: 내 적립금 화면`, async ({ page, baseURL }) => {
    await seedRewardLedgerInDb(SLUG, LOGIN, { payout: false });
    await login(page, baseURL!);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(`/shop/${SLUG}/me/rewards`);
    await expect(rows(page)).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `tests/e2e/screenshots/SH-023-rewards-${vp.name}.png`, fullPage: true });
  });
}
