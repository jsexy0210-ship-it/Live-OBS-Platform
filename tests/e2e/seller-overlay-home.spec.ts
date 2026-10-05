import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-002-O 오버레이 전용 홈: 오버레이 전용 대표자는 /seller에서 이 홈으로 오고(업무 → 성과 → 방송, 스토어 기능 안내),
// 통합 요금제 대표자는 이 홈으로 보내지 않는다. dev-seed의 데모 쇼핑몰(통합 · demo-overlay)로 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller%2Fyoutube");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/youtube$/);
}

test("오버레이 전용 대표자: /seller가 오버레이 홈으로 열리고 업무·성과·방송·스토어 안내가 보인다", async ({ page }) => {
  await login(page, "demo-overlay-owner@example.com");
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller\/home-overlay$/);
  await expect(page.getByRole("heading", { name: "홈" })).toBeVisible();
  await expect(page.getByTestId("oh-todo")).toContainText("주문대기");
  await expect(page.getByTestId("oh-perf")).toContainText("매출");
  await expect(page.getByTestId("oh-broadcast").getByRole("link", { name: "방송 대시보드" })).toBeVisible();
  // 스토어 업무(입금·배송·재고)는 없고 통합 구독 안내가 있다
  await expect(page.getByText("입금 확인")).toHaveCount(0);
  const up = page.getByTestId("oh-upgrade");
  await expect(up).toContainText("통합 구독");
  await up.getByRole("link", { name: "구독 보기" }).click();
  await expect(page).toHaveURL(/\/seller\/subscription/);
  if (SHOTS) {
    await page.goto("/seller/home-overlay");
    await page.screenshot({ path: "tests/e2e/screenshots/SA-002-O-1440.png", fullPage: true });
  }
});

test("메뉴 「홈」으로도 열린다", async ({ page }) => {
  await login(page, "demo-overlay-owner@example.com");
  await page.goto("/seller/broadcast");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByText("홈", { exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/home-overlay$/);
});

test("통합 요금제 대표자는 오버레이 홈으로 가지 않는다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await page.goto("/seller");
  await expect(page.getByTestId("home-tasks")).toBeVisible();
  await expect(page).toHaveURL(/\/seller$/);
});
