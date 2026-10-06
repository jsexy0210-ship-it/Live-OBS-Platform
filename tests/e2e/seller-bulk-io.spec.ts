import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-018 엑셀 일괄 등록 · 내보내기: CSV 올리기 → 올린 파일 확인(오류 행 건너뜀) → 반영 → 처리 이력에서 되돌리기.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const URL_PATH = "/seller/products/bulk";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page, email = "demo-owner@example.com") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent(URL_PATH)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${URL_PATH}$`));
}
const confirmBtn = (page: Page, name: string) => page.getByRole("dialog").getByRole("button", { name, exact: true });

test("올리기 → 확인 → 반영 → 되돌리기", async ({ page }) => {
  const name = `일괄 시험 상품 ${Date.now()}`;
  const csv = `상품명,판매가,상태,설명,차감시점,카테고리,옵션명,옵션추가금,재고,SKU\r\n${name},5000,판매중,시험,결제 시,,기본,0,3,BK-1\r\n오류 상품,가격아님,판매중,,,,기본,0,1,BK-2\r\n`;
  await open(page);
  await expect(page.getByRole("heading", { level: 1, name: "엑셀 일괄 등록 · 내보내기" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "엑셀로 올리기 · 내려받기" })).toHaveAttribute("aria-current", "page");

  await page.getByLabel("CSV 파일 선택").setInputFiles({ name: "상품_시험.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
  const pv = page.getByTestId("bulk-preview");
  await expect(pv).toContainText("올린 파일 확인 · 상품_시험.csv");
  await expect(pv.getByTestId("bulk-products")).toContainText(name);
  await expect(pv.getByTestId("bulk-errors")).toContainText("판매가는 숫자로 입력해 주십시오");
  await expect(pv).toContainText("1개");
  for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: `tests/e2e/screenshots/SA-018-bulk-${w}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 반영: 확인 창 → 등록 → 처리 이력에 반영 완료 + 되돌리기
  await pv.getByRole("button", { name: "1개 반영" }).click();
  await expect(page.getByRole("dialog")).toContainText("1개 상품을 등록하시겠습니까?");
  await confirmBtn(page, "등록").click();
  await expect(page.getByText("1개 등록했습니다")).toBeVisible();
  await expect(page.getByTestId("bulk-preview")).toHaveCount(0);
  const row = page.getByTestId("bulk-job-row").filter({ hasText: "상품_시험.csv" }).first();
  await expect(row).toContainText("반영 완료");
  await row.getByRole("button", { name: "되돌리기" }).click();
  await expect(page.getByRole("dialog")).toContainText("이 등록을 되돌리시겠습니까?");
  await confirmBtn(page, "되돌리기").click();
  await expect(page.getByText(/1개를 되돌렸습니다/)).toBeVisible();
  await expect(page.getByTestId("bulk-job-row").filter({ hasText: "상품_시험.csv" }).first()).toContainText("되돌림");
});

test("양식과 상품 내보내기는 내려받기 링크로 열린다", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("link", { name: "양식 내려받기" })).toHaveAttribute("href", "/api/seller/bulk-io/products/template");
  const res = await page.request.get("/api/seller/bulk-io/products/export");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
});

test("상품 권한이 없는 직원은 안내만 본다", async ({ page }) => {
  await open(page, "demo-viewer@example.com").catch(() => undefined);
  await page.goto(URL_PATH);
  await expect(page.getByText(/이 계정은 이 일을 할 수 없습니다|보기만 할 수 있습니다|처리 이력만 볼 수 있습니다/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "파일 올리기" })).toHaveCount(0);
});
