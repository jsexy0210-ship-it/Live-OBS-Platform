import { expect, test, type Page } from "@playwright/test";
import { clearReturnsInDb, deliveredOrderInDb, orderStatusInDb } from "./returnDb";
import { submitSellerLogin } from "./sellerLogin";
import { okConfirm } from "./shopConfirm";

// SH-022-R 교환 · 반품 신청(구매자), SA-029 교환 · 반품(파트너스). 운영 빌드 + 데모 시드(demo-owner·demo-buyer1, 비밀번호 E2E_PASSWORD).
// 시작·끝에 이 시험이 만든 주문과 신청을 테스트 DB에서 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOT = "tests/e2e/screenshots";
let orderId = "";
let orderNo = 0;
const REWARD_USED = 1000;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearReturnsInDb(SLUG);
  // 적립금 1,000원을 쓴 주문: 환불 미리보기에 현금 환불과 적립금 반환이 따로 나온다
  ({ orderId, orderNo } = await deliveredOrderInDb(SLUG, "demo-buyer1@example.com", REWARD_USED));
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
    // 신청 기한(7일)과 수거 방법이 보인다. 카드 주문이라 환불 계좌는 묻지 않는다
    await expect(dlg.getByTestId("rt-deadline")).toContainText("배송 완료 뒤 7일 안에 신청할 수 있어요");
    await expect(dlg.getByLabel("직접 보낼게요")).toBeChecked();
    await expect(dlg.getByText("환불받을 계좌")).toHaveCount(0);
    await dlg.getByLabel("택배 수거를 원해요").check();
    // 반품은 돌려보낼 상품과 수량을 고른다(처음에는 전부)
    await expect(dlg.getByText("돌려보낼 상품", { exact: true })).toBeVisible();
    await expect(dlg.getByRole("combobox", { name: /수량$/ }).first()).toHaveValue("1");
    await page.screenshot({ path: `${SHOT}/sh022r-form-390.png`, fullPage: true });
    // 사유를 고르기 전에는 신청할 수 없고, 「기타」는 자세한 사유가 있어야 한다
    await expect(dlg.getByRole("button", { name: "신청하기" })).toBeDisabled();
    await dlg.getByLabel("사유", { exact: true }).selectOption("OTHER");
    await expect(dlg.getByRole("button", { name: "신청하기" })).toBeDisabled();
    await dlg.getByLabel("자세한 사유").fill("마음에 들지 않아요");
    await expect(dlg.getByRole("button", { name: "신청하기" })).toBeEnabled();
    await dlg.getByRole("button", { name: "신청하기" }).click();
    await okConfirm(page, "신청하기");
    await expect(page.getByText("신청했어요. 판매자가 확인하면 알려 드릴게요")).toBeVisible();
    const item = section.getByTestId("return-item");
    await expect(item).toContainText("반품 · 기타");
    await expect(item).toContainText("신청했어요 · 판매자가 확인하고 있어요");
    await expect(section.getByRole("button", { name: "교환 · 반품 신청" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/sh022r-requested-390.png`, fullPage: true });
    // 철회하면 다시 신청할 수 있다
    await item.getByRole("button", { name: "신청 거두기" }).click();
    await okConfirm(page, "신청 거두기");
    await expect(section.getByTestId("return-item").first()).toContainText("신청을 거뒀어요");
    await expect(section.getByRole("button", { name: "교환 · 반품 신청" })).toBeVisible();
    await section.getByRole("button", { name: "교환 · 반품 신청" }).click();
    const again = page.getByRole("dialog", { name: "교환 · 반품 신청" });
    await again.getByLabel("사유", { exact: true }).selectOption("DEFECTIVE");
    await again.getByLabel("택배 수거를 원해요").check();
    await again.getByLabel("자세한 사유").fill("박스가 찢어져 왔어요");
    await again.getByRole("button", { name: "신청하기" }).click();
    await okConfirm(page, "신청하기");
    await expect(section.getByTestId("return-item").first()).toContainText("신청했어요");
  });

  test("파트너스: 접수 → 입고 확인 → 검수 → 환불. 구매자 화면에도 환불 완료가 보인다", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/seller/login?next=${encodeURIComponent("/seller/returns")}`);
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/returns$/);
    await expect(page.getByRole("link", { name: "취소 · 교환 · 반품" })).toHaveClass(/on/);
    const sum = page.getByTestId("rt-summary");
    await expect(sum).toContainText("접수 (처리 필요)");
    await expect(sum).toContainText("반품률 (30일)");
    await page.screenshot({ path: `${SHOT}/sa029-summary-1440.png` });
    const row = page.getByTestId("return-row").filter({ hasText: `주문 ${orderNo}` }).first();
    await expect(row).toContainText("접수");
    await row.click();
    const dlg = page.getByRole("dialog", { name: new RegExp(`반품 신청 · 주문 ${orderNo}`) });
    await expect(dlg).toContainText("박스가 찢어져 왔어요");
    await expect(dlg.getByLabel("사유 주체")).toHaveValue("SELLER");
    await page.screenshot({ path: `${SHOT}/sa029-detail-1440.png` });
    await expect(dlg.getByLabel("수거 방법")).toHaveValue("COURIER"); // 구매자가 고른 희망
    await dlg.getByRole("button", { name: "접수" }).click();
    await expect(page.getByText("신청을 접수했습니다")).toBeVisible();
    await expect(dlg).toContainText("수거 중");
    // 환불 미리보기를 못 불러오면(처음 한 번) 「다시 시도」가 보이고 환불은 막힌다. 다시 시도하면 실제 값이 나온다
    let nulled = false;
    await page.route(/\/api\/seller\/returns\/[0-9a-f-]{36}$/, async (route) => {
      if (nulled || route.request().method() !== "GET") return route.continue();
      nulled = true;
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), refundPreview: null } });
    });
    await dlg.getByRole("button", { name: "입고 확인" }).click();
    await expect(dlg).toContainText("검수 중");
    await expect(dlg.getByRole("alert")).toContainText("환불 금액을 불러오지 못했습니다");
    await expect(dlg.getByRole("button", { name: "환불", exact: true })).toBeDisabled();
    await dlg.getByRole("button", { name: "다시 시도" }).click();
    // 검수 결과를 저장하기 전에는 환불할 수 없다
    await expect(dlg.getByRole("button", { name: "환불", exact: true })).toBeDisabled();
    await dlg.getByLabel("검수 결과 입력").selectOption("OK");
    await dlg.getByRole("button", { name: "검수 결과 저장" }).click();
    await expect(page.getByText("검수 결과를 저장했습니다")).toBeVisible();
    await expect(dlg.getByTestId("rt-inspection")).toContainText("이상 없음");
    // 판매자 사정(전부 반품): 현금 환불 = 상품 금액 − 적립금 반환, 적립금 반환 = 쓴 적립금 전부
    await expect(dlg.getByTestId("rt-reward")).toHaveText("적립금 반환 1,000원");
    // 결제한 금액(= 상품 금액 − 쓴 적립금, 배송비 0원)만큼이 현금으로 돌아간다
    const paid = ((await (await page.request.get(`/api/seller/orders/${orderId}`)).json()) as { totalAmount: number }).totalAmount;
    await expect(dlg.getByTestId("rt-cash")).toHaveText(`현금 환불 ${paid.toLocaleString("ko-KR")}원`);
    await page.screenshot({ path: `${SHOT}/sa029-reward-1440.png` });
    // 환불 금액이 보이고, 누르면 환불 상태가 된다
    await dlg.getByRole("button", { name: "환불", exact: true }).click();
    await expect(page.getByText("환불을 처리했습니다")).toBeVisible();
    await expect(dlg).toContainText("완료");
    expect(await orderStatusInDb(orderId)).toBe("REFUNDED");
    await dlg.getByRole("button", { name: "닫기" }).click();
    await page.getByRole("tab", { name: "완료 · 거절" }).click();
    // 철회한 첫 신청도 같은 탭에 있다(최신순이라 첫 줄이 이번 신청)
    await expect(page.getByTestId("return-row").filter({ hasText: `주문 ${orderNo}` }).first()).toContainText("완료");

    await buyerLogin(page, baseURL!);
    await page.goto(`/shop/${SLUG}/orders/${orderId}`);
    await expect(page.getByRole("region", { name: "교환 · 반품" }).getByTestId("return-item").first()).toContainText("환불이 끝났어요");
    await expect(page.getByTestId("refund-history")).toContainText("환불 내역");
    await expect(page.getByTestId("refund-history")).toContainText("환불");
  });
});
