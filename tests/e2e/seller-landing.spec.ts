import { expect, test } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// UX-06·J-2: 로그인 직후는 권한·요금제상 열 수 있는 첫 메뉴로 보낸다. /seller는 쇼핑몰 통합 요금제에서 파트너스 홈(SA-002)이다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function loginAs(page: import("@playwright/test").Page, email: string, next?: string) {
  await page.goto(next ? `/seller/login?next=${encodeURIComponent(next)}` : "/seller/login");
  await submitSellerLogin(page, email, PASSWORD);
}

test("대표자: 로그인 직후는 상품 목록으로 가고, /seller는 파트너스 홈(SA-002)이다", async ({ page }) => {
  await loginAs(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByRole("heading", { name: "홈", exact: true })).toBeVisible();
});

test("배송 담당 직원(주문·배송 권한만): 권한 없는 상품 목록이 아니라 주문 화면으로 간다", async ({ page }) => {
  await loginAs(page, "demo-viewer@example.com");
  await expect(page).toHaveURL(/\/seller\/orders$/);
  await expect(page.getByText("이 기능은 권한이 필요합니다")).toHaveCount(0);
  // /seller는 홈이고, 읽을 수 있는 처리할 일(입금 확인·배송 준비·반품 요청)만 보인다
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByTestId("home-task-depositPending")).toBeVisible();
});

test("상품 담당 직원: 상품 목록으로 간다", async ({ page }) => {
  await loginAs(page, "demo-staff@example.com");
  await expect(page).toHaveURL(/\/seller\/products$/);
});

test("권한이 하나도 없는 직원: 막힌 상품 목록 대신 열 수 있는 첫 메뉴(상품 리뷰)로 간다", async ({ page }) => {
  await loginAs(page, "demo-none@example.com");
  await expect(page).toHaveURL(/\/seller\/reviews$/);
  await expect(page.getByText("이 기능은 권한이 필요합니다")).toHaveCount(0);
  // /seller는 홈이고, 읽을 수 있는 항목이 없으면 빈 안내를 보인다
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByText("확인할 수 있는 처리할 일이 없습니다")).toBeVisible();
});

test("가려는 주소(next)가 있으면 그대로 간다", async ({ page }) => {
  await loginAs(page, "demo-owner@example.com", "/seller/orders");
  await expect(page).toHaveURL(/\/seller\/orders$/);
});
