import { expect, test } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 로그인 직후는 파트너스 홈(/seller, SA-002)이다. 요금제·권한에 맞는 분기는 /seller 화면이 한다(오버레이 전용은 home-overlay, 홈을 못 여는 계정은 열 수 있는 첫 메뉴).
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function loginAs(page: import("@playwright/test").Page, email: string, next?: string) {
  await page.goto(next ? `/seller/login?next=${encodeURIComponent(next)}` : "/seller/login");
  await submitSellerLogin(page, email, PASSWORD);
}

test("대표자: 로그인 직후는 파트너스 홈(SA-002)이고 GNB 「홈」이 켜진다", async ({ page }) => {
  await loginAs(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).locator(".gnb-i.on")).toHaveText("홈");
  await expect(page.getByRole("heading", { name: "홈", exact: true })).toBeVisible();
});

test("배송 담당 직원(주문·배송 권한만): 홈으로 가고, 읽을 수 있는 처리할 일(입금 확인·배송 준비·반품 요청)만 보인다", async ({ page }) => {
  await loginAs(page, "demo-viewer@example.com");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toHaveCount(0);
  await expect(page.getByTestId("home-task-depositPending")).toBeVisible();
});

test("상품 담당 직원: 홈으로 간다", async ({ page }) => {
  await loginAs(page, "demo-staff@example.com");
  await expect(page).toHaveURL(/\/seller$/);
});

test("권한이 하나도 없는 직원: 홈으로 가고, 읽을 수 있는 항목이 없으면 빈 안내를 보인다", async ({ page }) => {
  await loginAs(page, "demo-none@example.com");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toHaveCount(0);
  await expect(page.getByText("오늘 처리할 일이 없습니다")).toBeVisible();
});

test("가려는 주소(next)가 있으면 그대로 간다", async ({ page }) => {
  await loginAs(page, "demo-owner@example.com", "/seller/orders");
  await expect(page).toHaveURL(/\/seller\/orders$/);
});
