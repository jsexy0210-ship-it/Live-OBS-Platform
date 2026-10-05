import { expect, test } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// UX-06·J-2: 로그인 직후와 /seller 진입은 권한·요금제상 열 수 있는 첫 메뉴로 보낸다(SA-002 홈이 생기기 전까지).
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function loginAs(page: import("@playwright/test").Page, email: string, next?: string) {
  await page.goto(next ? `/seller/login?next=${encodeURIComponent(next)}` : "/seller/login");
  await submitSellerLogin(page, email, PASSWORD);
}

test("대표자: 로그인 직후와 /seller 모두 상품 목록으로 간다", async ({ page }) => {
  await loginAs(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller\/products$/);
});

test("배송 담당 직원(주문·배송 권한만): 권한 없는 상품 목록이 아니라 주문 화면으로 간다", async ({ page }) => {
  await loginAs(page, "demo-viewer@example.com");
  await expect(page).toHaveURL(/\/seller\/orders$/);
  await expect(page.getByText("이 기능은 권한이 필요합니다")).toHaveCount(0);
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller\/orders$/);
});

test("상품 담당 직원: 상품 목록으로 간다", async ({ page }) => {
  await loginAs(page, "demo-staff@example.com");
  await expect(page).toHaveURL(/\/seller\/products$/);
});

test("권한이 하나도 없는 직원: 막힌 상품 목록 대신 열 수 있는 첫 메뉴(상품 리뷰)로 간다", async ({ page }) => {
  await loginAs(page, "demo-none@example.com");
  await expect(page).toHaveURL(/\/seller\/reviews$/);
  await expect(page.getByText("이 기능은 권한이 필요합니다")).toHaveCount(0);
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller\/reviews$/);
});

test("가려는 주소(next)가 있으면 그대로 간다", async ({ page }) => {
  await loginAs(page, "demo-owner@example.com", "/seller/orders");
  await expect(page).toHaveURL(/\/seller\/orders$/);
});
