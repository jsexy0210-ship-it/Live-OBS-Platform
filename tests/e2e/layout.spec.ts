import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 파트너스 관리자 업무용 틀(대표님 지시 2026-10-04): 상단 GNB(대분류) + 왼쪽 LNB(하위 메뉴), 좁은 화면에서는 햄버거 + 서랍.
// E2E_SCREENSHOTS=1이면 홈(상품 목록)·주문 목록·쇼핑몰 설정을 PC(1440)·모바일(390), 라이트·다크로 tests/e2e/screenshots에 남긴다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, email: string, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${next.replace(/\//g, "\\/")}$`));
}

const gnb = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });
const lnb = (page: Page) => page.getByRole("complementary", { name: "파트너스 메뉴" });

async function noSideScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
}

test("대분류를 누르면 왼쪽 메뉴가 그 대분류의 하위 메뉴로 바뀐다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "demo-owner@example.com", "/seller/products");

  // 대표자는 대분류 9개를 모두 본다
  await expect(gnb(page).locator(".gnb-i")).toHaveText(["홈", "방송", "주문", "상품", "고객", "마케팅", "통계", "설정"]);
  await expect(gnb(page).getByRole("link", { name: "상품", exact: true })).toHaveClass(/\bon\b/);
  await expect(lnb(page).locator(".lnb-sec.on .lnb-h")).toHaveText("상품");
  await expect(lnb(page).getByRole("link", { name: "상품 목록" })).toBeVisible();
  await expect(lnb(page).getByRole("link", { name: "상품 목록" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".loc-bar")).toContainText("상품›상품 목록");

  // 화면이 없는 대분류(홈): 화면은 그대로, 왼쪽 메뉴만 바뀌고 메뉴는 「준비 중」으로 흐리다
  await gnb(page).getByRole("button", { name: "홈", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await expect(lnb(page).locator(".lnb-sec.on .lnb-h")).toHaveText("홈");
  await expect(lnb(page).getByText("홈", { exact: true }).last()).toHaveAttribute("aria-disabled", "true");
  await expect(lnb(page).getByRole("link", { name: "상품 목록" })).toBeHidden();

  // 화면이 있는 대분류(주문): 첫 화면으로 옮기고 왼쪽 메뉴가 주문 하위 메뉴가 된다
  await gnb(page).getByRole("link", { name: "주문", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/orders$/);
  await expect(lnb(page).getByRole("link", { name: "전체 주문" })).toHaveAttribute("aria-current", "page");
  await expect(lnb(page).getByText("입금 확인")).toBeVisible();

  // 쇼핑몰 설정: 첫 메뉴(쇼핑몰 정보)로 들어가고, 하위 메뉴 이동 시 대분류 표시가 유지된다
  await gnb(page).getByRole("link", { name: "설정", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/settings\/shop$/);
  await lnb(page).getByRole("link", { name: "직원 계정" }).click();
  await expect(page).toHaveURL(/\/seller\/staff$/);
  await expect(gnb(page).getByRole("link", { name: "설정", exact: true })).toHaveClass(/\bon\b/);
  await expect(lnb(page).getByRole("link", { name: "직원 계정" })).toHaveAttribute("aria-current", "page");

  // 상단 유틸
  await expect(page.locator(".gnb").getByRole("link", { name: "쇼핑몰 보기" })).toHaveAttribute("href", /^\/shop\//);
  await expect(page.locator(".gnb").getByRole("button", { name: "로그아웃" })).toBeVisible();
});

test("왼쪽 메뉴 제목 줄과 본문 첫 줄(경로 줄)은 위 시작선과 아래 선이 같은 높이다(오차 0px)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "demo-owner@example.com", "/seller/products");
  for (const path of ["/seller/products", "/seller/orders", "/seller/stats", "/seller/settings/shop"]) {
    await page.goto(path);
    const head = lnb(page).locator(".lnb-sec.on .lnb-h");
    const bar = page.locator(".loc-bar").first();
    await expect(head).toBeVisible();
    await expect(bar).toBeVisible();
    const h = (await head.boundingBox())!;
    const b = (await bar.boundingBox())!;
    expect({ path, top: h.y, bottom: h.y + h.height }).toEqual({ path, top: b.y, bottom: b.y + b.height });
  }
});

test("파트너스 관리자 화면 바탕(body·본문 영역)은 흰색이다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "demo-owner@example.com", "/seller/products");
  for (const path of ["/seller/products", "/seller/orders", "/seller/stats", "/seller/settings/shop"]) {
    await page.goto(path);
    await expect(page.locator("main.main").first()).toBeVisible();
    // 본문 영역에서 위로 올라가며 처음 만나는 칠한 배경(투명 제외)
    const bg = await page.evaluate(() => {
      const paint = (el: Element | null) => {
        for (let n = el; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor;
          if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
        }
        return "none";
      };
      return { body: getComputedStyle(document.body).backgroundColor, main: paint(document.querySelector("main.main")) };
    });
    expect({ path, ...bg }).toEqual({ path, body: "rgb(255, 255, 255)", main: "rgb(255, 255, 255)" });
  }
});

test("권한 없는 직원에게는 메뉴와, 하위 메뉴가 모두 숨겨진 대분류가 보이지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 상품 권한만 있는 직원(상품 리뷰·쿠폰은 권한 없이 조회라 게시판·프로모션 대분류는 남는다)
  await login(page, "demo-staff@example.com", "/seller/products");
  await expect(gnb(page).locator(".gnb-i")).toHaveText(["홈", "상품", "고객", "마케팅", "설정"]);
  await gnb(page).getByRole("link", { name: "설정", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/settings\/shop$/);
  // 대표자 전용·설정 권한 메뉴는 숨는다
  await expect(lnb(page).locator(".lnb-sec.on .lnb-i")).toHaveText(["쇼핑몰 정보"]);
  await expect(page.getByRole("link", { name: "직원 계정" })).toHaveCount(0);
});

test("모바일 폭에서는 GNB가 햄버거로 접히고 서랍에 전체 메뉴가 열리며, 가로 스크롤이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "demo-owner@example.com", "/seller/products");
  await expect(gnb(page)).toBeHidden();
  await noSideScroll(page);

  const drawerLink = lnb(page).getByRole("link", { name: "전체 주문" });
  await expect(drawerLink).not.toBeInViewport();
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  // 서랍에는 모든 대분류와 하위 메뉴, 상단 유틸이 함께 있다
  await expect(drawerLink).toBeInViewport();
  await expect(lnb(page).locator(".lnb-h")).toHaveText(["홈", "방송", "주문", "상품", "고객", "마케팅", "통계", "설정"]);
  await expect(lnb(page).getByRole("button", { name: "로그아웃" })).toBeVisible();
  await page.getByRole("button", { name: "메뉴 닫기" }).click();
  await expect(drawerLink).not.toBeInViewport();

  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await drawerLink.click();
  await expect(page).toHaveURL(/\/seller\/orders$/);
  await expect(drawerLink).not.toBeInViewport();
  await noSideScroll(page);

  for (const path of ["/seller/settings/shop", "/seller/products/new", "/seller/staff"]) {
    await page.goto(path);
    await expect(page.locator(".loc-bar")).toBeVisible();
    await noSideScroll(page);
  }
});

test("화면 스크린샷(PC·모바일, 라이트·다크)", async ({ page }) => {
  test.skip(!SHOTS, "E2E_SCREENSHOTS=1일 때만 찍는다");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "demo-owner@example.com", "/seller/products");
  const pages: [string, string][] = [
    ["products", "/seller/products"],
    ["orders", "/seller/orders"],
    ["settings", "/seller/settings/shop"],
    ["product-new", "/seller/products/new"],
  ];
  for (const [w, h, tag] of [
    [1440, 900, "pc"],
    [390, 844, "m"],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ["light", "dark"]) {
      for (const [name, path] of pages) {
        await page.goto(path);
        await expect(page.locator(".loc-bar")).toBeVisible();
        await page.evaluate((t) => document.querySelector(".seller-app")?.setAttribute("data-theme", t), theme);
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: `tests/e2e/screenshots/layout-${name}-${tag}-${theme}.png` });
      }
    }
  }
});
