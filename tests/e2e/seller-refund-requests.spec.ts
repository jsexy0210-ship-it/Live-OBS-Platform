import { expect, test, type Page } from "@playwright/test";
import { createRefundRequestInDb, deleteRefundRequestInDb, refundRequestInDb, refundableOrderIdInDb } from "./rewardDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-023 구매자 환불 요청 처리: 목록 · 거절(사유) · 승인(요청한 상품으로 환불). 요청은 DB에 바로 만들고, 파트너스 화면과 실제 API로 처리한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const created: string[] = [];

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  for (const id of created) await deleteRefundRequestInDb(id);
});

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/orders/refund-requests")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === "/seller/orders/refund-requests");
}
const rowOf = (page: Page, orderNo: number) => page.getByTestId("refund-request-row").filter({ has: page.locator("td:nth-child(3)", { hasText: new RegExp(`^${orderNo}$`) }) });

test("주문 목록에서 환불 요청 화면으로 들어간다", async ({ page }) => {
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/orders")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  // 왼쪽 메뉴에도 같은 이름의 항목이 있어, 주문 목록 화면 안의 링크로 한정한다
  await page.locator("main").getByRole("link", { name: "환불 요청" }).click();
  await expect(page).toHaveURL(/\/seller\/orders\/refund-requests$/);
  await expect(page.getByRole("heading", { level: 1, name: "환불 요청" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /처리 대기/ })).toHaveAttribute("aria-selected", "true");
});

test("거절: 사유를 적어야 확정할 수 있고, 거절 탭에 사유와 함께 남는다", async ({ page }) => {
  const order = await refundableOrderIdInDb("demo-shop", "CARD");
  const req = await createRefundRequestInDb(order, "CHANGE_OF_MIND", "마음이 바뀌었어요");
  created.push(req.id);
  await open(page);
  const row = rowOf(page, req.orderNo);
  await expect(row).toContainText("단순 변심");
  await row.getByRole("button", { name: "처리" }).click();
  const dialog = page.getByRole("dialog", { name: /환불 요청 · 주문/ });
  await expect(dialog).toContainText("마음이 바뀌었어요");
  await dialog.getByRole("button", { name: "거절", exact: true }).click();
  const confirm = dialog.getByRole("button", { name: "거절 확정" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("거절 사유").fill("이미 포장을 시작했습니다");
  await confirm.click();
  await expect(page.getByText("환불 요청을 거절했습니다")).toBeVisible();
  await expect(rowOf(page, req.orderNo)).toHaveCount(0);
  await page.getByRole("tab", { name: /거절/ }).click();
  await rowOf(page, req.orderNo).getByRole("button", { name: "처리" }).or(rowOf(page, req.orderNo).getByRole("button", { name: "보기" })).click();
  await expect(page.getByRole("dialog", { name: /환불 요청 · 주문/ })).toContainText("이미 포장을 시작했습니다");
  expect(await refundRequestInDb(req.id)).toMatchObject({ status: "REJECTED", rejectReason: "이미 포장을 시작했습니다", orderStatus: "PAID" });
});

test("승인: 사유 주체를 확인하고 금액에 동의해야 실행되며, 승인하면 주문이 환불된다", async ({ page }) => {
  const order = await refundableOrderIdInDb("demo-shop", "CARD");
  const req = await createRefundRequestInDb(order, "CHANGE_OF_MIND");
  created.push(req.id);
  await open(page);
  await rowOf(page, req.orderNo).getByRole("button", { name: "처리" }).click();
  const dialog = page.getByRole("dialog", { name: /환불 요청 · 주문/ });
  // 단순 변심이면 구매자 사정이 미리 골라져 있다
  await expect(dialog.getByRole("radio", { name: /구매자 사정/ })).toBeChecked();
  await expect(dialog.getByTestId("rr-cash")).toContainText(/현금 환불 [\d,]+원/);
  const run = dialog.getByRole("button", { name: "승인하고 환불" });
  await expect(run).toBeDisabled();
  await dialog.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.").check();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByText(/원 환불을 승인했습니다/)).toBeVisible();
  await expect(rowOf(page, req.orderNo)).toHaveCount(0);
  await page.getByRole("tab", { name: /승인/ }).click();
  await expect(rowOf(page, req.orderNo)).toBeVisible();
  expect(await refundRequestInDb(req.id)).toMatchObject({ status: "APPROVED", orderStatus: "REFUNDED" });
});
