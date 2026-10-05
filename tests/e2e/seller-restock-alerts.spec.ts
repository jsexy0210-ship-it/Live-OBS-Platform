import { expect, test, type Page } from "@playwright/test";
import { clearRestockInDb, seedRestockInDb } from "./restockDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-017 재입고 알림: 품절 상품 1개(대기 2명)와 이미 발송된 상품 1개(발송 1명)를 만들어 두고 상품별 수·상태를 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
let made: Awaited<ReturnType<typeof seedRestockInDb>>;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  made = await seedRestockInDb(SLUG);
});
test.afterAll(() => clearRestockInDb(SLUG, made));

const login = async (page: Page, email: string) => {
  await page.goto("/seller/login?next=%2Fseller%2Fproducts%2Frestock-alerts");
  await submitSellerLogin(page, email, PASSWORD);
};
const row = (page: Page, name: string) => page.getByTestId("restock-row").filter({ hasText: name });

test("대표자: 상품별 대기·발송 수가 서버 값과 같고 신청자는 보이지 않는다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/products\/restock-alerts$/);
  await expect(row(page, made.soldOutName)).toContainText("품절");
  await expect(row(page, made.soldOutName)).toContainText("2명");
  await expect(row(page, made.sentName)).toContainText("판매 가능");
  await expect(row(page, made.sentName).locator("td").nth(4)).toHaveText("1명");
  await expect(row(page, made.sentName).locator("td").nth(6)).not.toHaveText("-");
  // 화면 숫자가 API와 같다
  const api = await page.evaluate(async () => (await (await fetch("/api/seller/restock-alerts")).json()).items);
  const a = api.find((x: { name: string }) => x.name === made.soldOutName);
  expect([a.waiting, a.queued, a.sent, a.soldOut]).toEqual([2, 0, 0, true]);
  await expect(page.getByText("신청한 구매자 정보는 표시하지 않습니다")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-017-restock-1440.png", fullPage: true });
});

test("상품 관리 권한이 없는 직원은 권한 없음 안내를 본다", async ({ page }) => {
  await login(page, "demo-viewer@example.com");
  await expect(page).toHaveURL(/\/seller\/products\/restock-alerts$/);
  await expect(page.getByTestId("restock-row")).toHaveCount(0);
  await expect(page.getByText("상품 관리")).toBeVisible();
});
