import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 파트너스 셸 IA 개편(2026-10-05): GNB 8개, LNB 「환불 요청」, 상단 「공지 · 문의」·「도우미」 링크,
// 1024px 겹침 없음, 서랍(1024 미만)이 열린 채 Back을 누르면 서랍부터 닫힘.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

const gnb = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });
const lnb = (page: Page) => page.getByRole("complementary", { name: "파트너스 메뉴" });

test("GNB는 8개이고 고객·스토어·분석·설정 묶음에 메뉴가 들어 있다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products");
  await expect(gnb(page).locator(".gnb-i")).toHaveText(["홈", "방송", "주문", "상품", "고객", "스토어", "분석", "설정"]);
  const items = async (name: string) => {
    await gnb(page).getByRole("link", { name, exact: true }).click();
    await expect(gnb(page).getByRole("link", { name, exact: true })).toHaveClass(/\bon\b/);
    await expect(lnb(page).locator(".lnb-sec.on .lnb-h")).toHaveText(name);
    return lnb(page).locator(".lnb-sec.on .lnb-i").allTextContents();
  };
  expect(await items("고객")).toEqual(expect.arrayContaining(["회원 목록", "회원별 잔액", "구매자 문의", "상품 리뷰"]));
  expect(await items("스토어")).toEqual(["쿠폰", "배너 · 팝업", "공지·자주 묻는 질문"]);
});

test("주문 그룹에 환불 요청이 있고, 하위 화면에서 부모 메뉴가 켜져 있다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/orders/refund-requests");
  await expect(gnb(page).getByRole("link", { name: "주문", exact: true })).toHaveClass(/\bon\b/);
  await expect(lnb(page).getByRole("link", { name: "환불 요청" })).toHaveAttribute("aria-current", "page");
  await expect(lnb(page).getByRole("link", { name: "전체 주문" })).not.toHaveAttribute("aria-current", "page");
});

test("상단 「공지 · 문의」「도우미」는 링크로 열린다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products");
  const util = page.locator(".util-desk");
  await expect(util.getByRole("link", { name: "공지 · 문의" })).toHaveAttribute("href", "/seller/notices");
  await expect(util.getByRole("link", { name: "도우미" })).toHaveAttribute("href", "/seller/assistant");
  await util.getByRole("link", { name: "공지 · 문의" }).click();
  await expect(page).toHaveURL(/\/seller\/notices$/);
});

for (const width of [1024, 1100, 1280, 1440]) {
  test(`${width}px에서 GNB 메뉴·쇼핑몰 이름·상단 유틸이 겹치지 않는다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await login(page, "/seller/products");
    await expect(page.locator(".gnb-shop")).toBeVisible();
    const boxes = await page.evaluate(() => {
      const r = (el: Element) => {
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right };
      };
      const nav = document.querySelector(".gnb-nav")!;
      const shop = document.querySelector(".gnb-shop")!;
      const util = document.querySelector(".util-desk")!;
      return { nav: r(nav), shop: r(shop), util: r(util), navScroll: nav.scrollWidth - nav.clientWidth > 1 };
    });
    expect(boxes.nav.right).toBeLessThanOrEqual(boxes.shop.left + 0.5);
    expect(boxes.shop.right).toBeLessThanOrEqual(boxes.util.left + 0.5);
    expect(boxes.navScroll).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("서랍이 열린 채 Back을 누르면 페이지를 떠나지 않고 서랍만 닫힌다", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await login(page, "/seller/products");
  const before = page.url();
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.locator(".cs")).toHaveClass(/nav-open/);
  await page.goBack();
  await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
  expect(page.url()).toBe(before);
  // 닫기 버튼으로 닫으면 쌓인 기록도 없어져 Back이 이전 화면으로 간다
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("button", { name: "메뉴 닫기" }).click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
  await page.goBack();
  await expect(page).not.toHaveURL(/\/seller\/products$/);
});

test("고객 그룹 「구매자 문의」는 /seller/buyer-inquiries로 연결되고 그 화면에서 켜져 있다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/members");
  const link = lnb(page).getByRole("link", { name: "구매자 문의" });
  await expect(link).toHaveAttribute("href", "/seller/buyer-inquiries");
  await link.click();
  await expect(page).toHaveURL(/\/seller\/buyer-inquiries$/);
  await expect(gnb(page).getByRole("link", { name: "고객", exact: true })).toHaveClass(/\bon\b/);
  await expect(lnb(page).getByRole("link", { name: "구매자 문의" })).toHaveAttribute("aria-current", "page");
});
