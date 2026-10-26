import { expect, test, type Page } from "@playwright/test";
import { writeXlsx } from "../../lib/server/shop-bulk-io/xlsx";
import { submitSellerLogin } from "./sellerLogin";

// SA-018 엑셀 일괄 등록 · 내보내기: CSV 올리기 → 올린 파일 확인(오류 행 건너뜀) → 반영 → 처리 이력에서 되돌리기. 주문 · 회원 내보내기와 처리 이력의 「누가」 · 내보내기 이력.
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
  const menu = page.getByRole("complementary", { name: "파트너스 메뉴" });
  await expect(menu.locator("strong.lnb-parent").filter({ hasText: /^엑셀로 올리기 · 내려받기$/ })).toBeVisible();
  const leaf = menu.locator("a.lnb-sub-i").filter({ hasText: /^상품 일괄 등록 · 수정$/ });
  await expect(leaf).toHaveAttribute("href", `${URL_PATH}?section=register`);
  await expect(leaf).toHaveAttribute("aria-current", "page");

  await page.getByLabel("파일 선택").setInputFiles({ name: "상품_시험.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
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
  await expect(page.getByRole("dialog")).toContainText("1개 상품을 반영하시겠습니까?");
  await confirmBtn(page, "반영").click();
  await expect(page.getByText("1개 등록 · 0개 수정했습니다")).toBeVisible();
  await expect(page.getByTestId("bulk-preview")).toHaveCount(0);
  const row = page.getByTestId("bulk-job-row").filter({ hasText: "상품_시험.csv" }).first();
  await expect(row).toContainText("반영 완료");
  await row.getByRole("button", { name: "되돌리기" }).click();
  await expect(page.getByRole("dialog")).toContainText("이 반영을 되돌리시겠습니까?");
  await confirmBtn(page, "되돌리기").click();
  await expect(page.getByText(/1개를 되돌렸습니다/)).toBeVisible();
  await expect(page.getByTestId("bulk-job-row").filter({ hasText: "상품_시험.csv" }).first()).toContainText("되돌림");
});

test("양식과 상품 내보내기는 내려받기 링크로 열린다", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("link", { name: "양식 내려받기" })).toHaveAttribute("href", "/api/seller/bulk-io/products/template?format=xlsx");
  const res = await page.request.get("/api/seller/bulk-io/products/export");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
});

test("주문 · 회원 내보내기는 처리 이력에 언제 · 누가 · 사유로 남는다", async ({ page }) => {
  await open(page);
  // 주문 내보내기: 기간을 고르기 전에는 내려받을 수 없다
  const orderRow = page.getByRole("row").filter({ has: page.getByText("기간 선택 · 주문 · 결제 · 배송 상태") });
  await expect(orderRow.getByRole("button", { name: "내려받기" })).toBeDisabled();
  await page.getByLabel("시작일").fill("2026.10.01");
  await page.getByLabel("종료일").fill("2026.10.31");
  const orderDownload = page.waitForEvent("download");
  await orderRow.getByRole("button", { name: "내려받기" }).click();
  expect((await orderDownload).suggestedFilename()).toBe("orders-2026-10-01_2026-10-31.csv");
  await expect(page.getByText(/주문 \d+건을 내려받았습니다/)).toBeVisible();
  const orderHistory = page.getByTestId("bulk-job-row").filter({ hasText: "주문 내보내기 · 2026.10.01 ~ 2026.10.31" }).first();
  await expect(orderHistory).toContainText("대표자");
  await expect(orderHistory).toContainText("내려받음");

  // 회원 내보내기: 사유 창 → 사유 없이 직접 입력을 고르면 막고, 사유를 적으면 내려받는다
  await page.getByRole("button", { name: "사유 입력 뒤 내려받기" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("회원 내보내기 · 사유");
  await dialog.getByRole("radio", { name: "직접 입력" }).check();
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: "tests/e2e/screenshots/SA-018-member-reason-1440.png" });
  await dialog.getByRole("button", { name: "내려받기" }).click();
  await expect(dialog).toContainText("내보내는 사유를 적어 주십시오");
  const reason = `시험 사유 ${Date.now()}`;
  await dialog.getByLabel("직접 입력한 사유").fill(reason);
  const memberDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "내려받기" }).click();
  await memberDownload;
  await expect(dialog).toHaveCount(0);
  const memberHistory = page.getByTestId("bulk-job-row").filter({ hasText: reason }).first();
  await expect(memberHistory).toContainText("회원 내보내기");
  await expect(memberHistory).toContainText("사유 기록");
  await expect(memberHistory).toContainText("대표자");
  for (const [w, h] of [[1440, 900], [1024, 800]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: `tests/e2e/screenshots/SA-018-bulk-export-${w}.png`, fullPage: true });
  }
});

test("직원은 회원 내보내기를 할 수 없다", async ({ page }) => {
  await open(page, "demo-viewer@example.com").catch(() => undefined);
  await page.goto(URL_PATH);
  await expect(page.getByRole("button", { name: "사유 입력 뒤 내려받기" })).toHaveCount(0);
});

test("상품 권한이 없는 직원은 안내만 본다", async ({ page }) => {
  await open(page, "demo-viewer@example.com").catch(() => undefined);
  await page.goto(URL_PATH);
  await expect(page.getByText(/이 계정은 이 일을 할 수 없습니다|보기만 할 수 있습니다|처리 이력만 볼 수 있습니다/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "파일 올리기" })).toHaveCount(0);
});

test("엑셀(xlsx)로 새 상품을 올리고, 같은 상품명으로 다시 올리면 기존 상품 판매가 · 재고만 수정한다", async ({ page }) => {
  const name = `엑셀 시험 상품 ${Date.now()}`;
  const book = (price: string, stock: string, file: string) => ({
    name: file,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: writeXlsx([["상품명", "카테고리", "판매가", "재고"], [name, "", price, stock]]),
  });
  await open(page);
  const pv = page.getByTestId("bulk-preview");

  await page.getByLabel("파일 선택").setInputFiles(book("5000", "3", "엑셀_새상품.xlsx"));
  await expect(pv).toContainText("올린 파일 확인 · 엑셀_새상품.xlsx");
  await expect(pv).toContainText("새로 등록");
  await expect(pv.getByTestId("bulk-products")).toContainText("등록 가능");
  await pv.getByRole("button", { name: "1개 반영" }).click();
  await expect(page.getByRole("dialog")).toContainText("새 상품 1개는 숨김으로 등록합니다");
  await confirmBtn(page, "반영").click();
  await expect(page.getByText("1개 등록 · 0개 수정했습니다")).toBeVisible();

  await page.getByLabel("파일 선택").setInputFiles(book("7000", "5", "엑셀_수정.xlsx"));
  await expect(pv).toContainText("올린 파일 확인 · 엑셀_수정.xlsx");
  await expect(pv.getByTestId("bulk-products")).toContainText("기존 상품 · 판매가 · 재고만 수정");
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: "tests/e2e/screenshots/SA-018-bulk-update-1440.png", fullPage: true });
  await pv.getByRole("button", { name: "1개 반영" }).click();
  await expect(page.getByRole("dialog")).toContainText("기존 상품 1개는 판매가 · 재고만 수정합니다");
  await confirmBtn(page, "반영").click();
  await expect(page.getByText("0개 등록 · 1개 수정했습니다")).toBeVisible();
  const history = page.getByTestId("bulk-job-row");
  await expect(history.filter({ hasText: "엑셀_수정.xlsx" }).first()).toContainText("1개 수정");

  // 되돌리기: 수정은 반영 전 값으로, 등록은 삭제(시험 상품이 남지 않게 둘 다)
  for (const f of ["엑셀_수정.xlsx", "엑셀_새상품.xlsx"]) {
    await history.filter({ hasText: f }).first().getByRole("button", { name: "되돌리기" }).click();
    await confirmBtn(page, "되돌리기").click();
    await expect(history.filter({ hasText: f }).first()).toContainText("되돌림");
  }
});

test("엑셀 열 이름이 양식과 다르면 어느 열이 다른지 안내한다", async ({ page }) => {
  await open(page);
  await page.getByLabel("파일 선택").setInputFiles({
    name: "열이름.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: writeXlsx([["상품명", "카테고리", "가격", "재고"], ["시험", "", "1000", "1"]]),
  });
  await expect(page.getByRole("alert").filter({ hasText: "양식과 열 이름이 다릅니다" })).toContainText("판매가");
  await expect(page.getByTestId("bulk-preview")).toHaveCount(0);
});
