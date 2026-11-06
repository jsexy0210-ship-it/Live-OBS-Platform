import { expect, test } from "@playwright/test";
import { clearHomeHighlights, seedHomeHighlights } from "./homeHighlightsDb";

// 보드 SH-001-PC-IA · SH-001: 홈 「이번 주 인기 카드」 표(PC 5행 · 휴대폰 3행)와 히어로 옆 카드 셋(PC만). 값은 GET /api/shop/[slug]/home/highlights와 같다.
const SLUG = "demo-shop";
const SHOTS = "tests/e2e/screenshots";
let noticeId = "";

test.beforeAll(async () => {
  await clearHomeHighlights(SLUG);
  noticeId = (await seedHomeHighlights(SLUG, 6)).id;
});
test.afterAll(async () => {
  await clearHomeHighlights(SLUG);
});

test("PC 1440: 히어로 옆 카드 셋 · 인기 카드 표(최신 5장) 왼쪽 · 공지 표 오른쪽", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}`);
  const side = page.locator(".shop-hero-side");
  await expect(side.getByText("회원 혜택")).toBeVisible();
  await expect(side.getByText("이번 주 HIT 카드")).toBeVisible();
  await expect(side.getByRole("link", { name: /e2e홈 공지/ })).toHaveAttribute("href", `/shop/${SLUG}/help/notices/${noticeId}`);

  const hits = page.getByRole("region", { name: "이번 주 인기 카드" });
  const rows = hits.locator("tbody tr");
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText("e2e홈닉1");
  await expect(rows.first()).toContainText("e2e홈카드1");
  const [h, n] = await Promise.all([hits.boundingBox(), page.getByRole("region", { name: "공지" }).boundingBox()]);
  expect(Math.abs(h!.y - n!.y)).toBeLessThan(2);
  expect(n!.x).toBeGreaterThan(h!.x);
  await side.getByRole("link", { name: /이번 주 HIT 카드/ }).click();
  await expect(page).toHaveURL(/#home-hits$/);
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `${SHOTS}/SH-001-highlights-1440.png`, fullPage: true });
});

test("휴대폰 390: 인기 카드 표 3행, 히어로 옆 카드 · 가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/shop/${SLUG}`);
  const hits = page.getByRole("region", { name: "이번 주 인기 카드" });
  await expect(hits.locator("tbody tr:visible")).toHaveCount(3);
  await expect(page.locator(".shop-hero-side")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `${SHOTS}/SH-001-highlights-390.png`, fullPage: true });
});
