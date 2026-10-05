import { expect, test, type Page } from "@playwright/test";
import { clearReturnsInDb, deliveredOrderInDb, orderStatusInDb } from "./returnDb";
import { submitSellerLogin } from "./sellerLogin";

// SH-022-R 교환 · 반품 신청(구매자), SA-029 교환 · 반품(파트너스). 운영 빌드 + 데모 시드(demo-owner·demo-buyer1, 비밀번호 E2E_PASSWORD).
// 시작·끝에 이 시험이 만든 주문과 신청을 테스트 DB에서 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOT = "tests/e2e/screenshots";
let orderId = "";
let orderNo = 0;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearReturnsInDb(SLUG);
  ({ orderId, orderNo } = await deliveredOrderInDb(SLUG, "demo-buyer1@example.com"));
});
test.afterAll(() => clearReturnsInDb(SLUG));

async function buyerLogin(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

test.describe.serial("SH-022-R 교환·반품 신청 · SA-029 교환·반품 처리", () => {
  test("구매자: 주문 상세에서 신청 → 철회하고 다시 신청한다", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await buyerLogin(page, baseURL!);
    await page.goto(`/shop/${SLUG}/orders/${orderId}`);
    const section = page.getByRole("region", { name: "교환 · 반품" });
    await expect(section).toBeVisible();
    await section.getByRole("button", { name: "교환 · 반품 신청" }).click();
    const dlg = page.getByRole("dialog", { name: "교환 · 반품 신청" });
    // 사유를 고르기 전에는 신청할 수 없고, 「기타」는 자세한 사유가 있어야 한다
    await expect(dlg.getByRole("button", { name: "신청하기" })).toBeDisabled();
    await dlg.getByLabel("사유", { exact: true }).selectOption("OTHER");
    await expect(dlg.getByRole("button", { name: "신청하기" })).toBeDisabled();
    await dlg.getByLabel("자세한 사유").fill("마음에 들지 않아요");
    await expect(dlg.getByRole("button", { name: "신청하기" })).toBeEnabled();
    await dlg.getByRole("button", { name: "신청하기" }).click();
    await expect(page.getByText("신청했어요. 판매자가 확인하면 알려 드릴게요")).toBeVisible();
    const item = section.getByTestId("return-item");
    await expect(item).toContainText("반품 · 기타");
    await expect(item).toContainText("신청했어요 · 판매자가 확인하고 있어요");
    await expect(section.getByRole("button", { name: "교환 · 반품 신청" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/sh022r-requested-390.png`, fullPage: true });
    // 철회하면 다시 신청할 수 있다
    await item.getByRole("button", { name: "신청 철회" }).click();
    await expect(section.getByTestId("return-item").first()).toContainText("철회했어요");
    await expect(section.getByRole("button", { name: "교환 · 반품 신청" })).toBeVisible();
    await section.getByRole("button", { name: "교환 · 반품 신청" }).click();
    const again = page.getByRole("dialog", { name: "교환 · 반품 신청" });
    await again.getByLabel("사유", { exact: true }).selectOption("DEFECTIVE");
    await again.getByLabel("자세한 사유").fill("박스가 찢어져 왔어요");
    await again.getByRole("button", { name: "신청하기" }).click();
    await expect(section.getByTestId("return-item").first()).toContainText("신청했어요");
  });

  test("파트너스: 접수 → 회수 완료 → 환불. 구매자 화면에도 환불 완료가 보인다", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/seller/login?next=${encodeURIComponent("/seller/returns")}`);
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/returns$/);
    await expect(page.getByRole("link", { name: "교환 · 반품" })).toHaveClass(/on/);
    const row = page.getByTestId("return-row").filter({ hasText: `주문 ${orderNo}` }).first();
    await expect(row).toContainText("접수 대기");
    await row.click();
    const dlg = page.getByRole("dialog", { name: new RegExp(`반품 신청 · 주문 ${orderNo}`) });
    await expect(dlg).toContainText("박스가 찢어져 왔어요");
    await expect(dlg.getByLabel("사유 주체")).toHaveValue("SELLER");
    await page.screenshot({ path: `${SHOT}/sa029-detail-1440.png` });
    await dlg.getByRole("button", { name: "접수" }).click();
    await expect(page.getByText("신청을 접수했습니다")).toBeVisible();
    await expect(dlg).toContainText("회수 중");
    await dlg.getByRole("button", { name: "회수 완료" }).click();
    await expect(dlg).toContainText("회수 완료");
    // 환불 금액이 보이고, 누르면 환불 상태가 된다
    await expect(dlg).toContainText("환불 금액");
    await dlg.getByRole("button", { name: "환불", exact: true }).click();
    await expect(page.getByText("환불을 처리했습니다")).toBeVisible();
    await expect(dlg).toContainText("완료");
    expect(await orderStatusInDb(orderId)).toBe("REFUNDED");
    await dlg.getByRole("button", { name: "닫기" }).click();
    await page.getByRole("tab", { name: "완료" }).click();
    await expect(page.getByTestId("return-row").filter({ hasText: `주문 ${orderNo}` })).toContainText("완료");

    await buyerLogin(page, baseURL!);
    await page.goto(`/shop/${SLUG}/orders/${orderId}`);
    await expect(page.getByRole("region", { name: "교환 · 반품" }).getByTestId("return-item").first()).toContainText("환불이 끝났어요");
  });
});
