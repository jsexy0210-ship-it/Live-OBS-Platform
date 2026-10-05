import { expect, test, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { setOptionStockInDb } from "./cartDb";
import { allowRewardUseInDb, deleteOrderInDb, liveVersionInDb, markItemOpenedInDb, rewardBalanceInDb } from "./rewardDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-023 환불 창 「현금 환불 · 적립금 반환」: 실제로 적립금 1,000원을 쓴 주문(구매자 주문 → 무통장 → 입금 확인)을 파트너스 환불 창에서 열어
// 두 줄이 서버 계산대로 나오고, 환불하면 적립금이 구매자에게 돌아가는지 본다. 이 시험이 만든 주문은 끝에 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const BUYER = "demo-buyer1@example.com";
const REWARD = 1000;
const created: string[] = [];
let prevStock = 0;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await allowRewardUseInDb(SLUG, BUYER, 5000);
  // 주문마다 재고가 줄고 시험이 지운 주문의 재고는 돌아오지 않으므로, 시작할 때 넉넉히 채운다
  prevStock = await setOptionStockInDb(SLUG, "문라이트 컬렉션 박스", "1박스", 50);
});
test.afterAll(async () => {
  for (const id of created) await deleteOrderInDb(id);
  await setOptionStockInDb(SLUG, "문라이트 컬렉션 박스", "1박스", prevStock);
});

// 구매자가 적립금 1,000원을 쓰고 상품(옵션)을 주문 → 무통장 → 파트너스가 입금 확인(결제 완료). 주문 id를 돌려준다.
async function paidOrder(page: Page, baseURL: string, playwright: PlaywrightWorkerArgs["playwright"], lines: { product: string; option?: string; quantity: number }[]): Promise<string> {
  const buyer = await playwright.request.newContext({ baseURL });
  const origin = { origin: baseURL };
  expect((await buyer.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: BUYER, password: PASSWORD }, headers: origin })).status()).toBe(200);
  const list = (await (await buyer.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  const items: { optionId: string; quantity: number }[] = [];
  for (const l of lines) {
    const pid = list.products.find((p) => p.name === l.product)!.id;
    const prod = (await (await buyer.get(`/api/shop/${SLUG}/products/${pid}`)).json()) as { product: { options: { id: string; name: string }[] } };
    const opt = l.option ? prod.product.options.find((o) => o.name === l.option)! : prod.product.options[0]!;
    items.push({ optionId: opt.id, quantity: l.quantity });
  }
  const consent = (await (await buyer.get(`/api/shop/${SLUG}/order-consent`)).json()) as { consents: { version: string }[] };
  const o = await buyer.post(`/api/shop/${SLUG}/orders`, {
    headers: origin,
    data: {
      items,
      consent: { agreed: true, noticeVersion: consent.consents[0].version },
      rewardUseAmount: REWARD,
      shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12" },
      saveAddress: false,
    },
  });
  expect(o.ok(), await o.text()).toBe(true);
  const { orderId } = (await o.json()) as { orderId: string };
  created.push(orderId);
  expect((await buyer.post(`/api/shop/${SLUG}/payments/bank-transfer`, { data: { orderId }, headers: origin })).status()).toBe(200);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/orders")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === "/seller/orders");
  const confirm = await page.evaluate(
    async ({ orderId, v }) => {
      const r = await fetch("/api/seller/payments/deposits/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderIds: [orderId], expectedVersion: v }),
      });
      return (await r.json()) as { results: { result: string }[] };
    },
    { orderId, v: await liveVersionInDb(SLUG) },
  );
  expect(confirm.results[0]!.result).toBe("paid");
  return orderId;
}

test("적립금을 쓴 주문의 환불 창: 현금 환불과 적립금 반환이 따로 보이고, 환불하면 적립금이 돌아간다", async ({ page, baseURL, playwright }) => {
  test.setTimeout(90_000);
  await allowRewardUseInDb(SLUG, BUYER, 5000);
  const orderId = await paidOrder(page, baseURL!, playwright, [{ product: "문라이트 컬렉션 박스", quantity: 1 }]);
  expect(await rewardBalanceInDb(SLUG, BUYER)).toBe(5000 - REWARD);
  await page.goto(`/seller/orders/${orderId}`);
  await page.getByRole("button", { name: "취소 · 환불" }).click();
  const dlg = page.getByRole("dialog", { name: "취소 · 환불 처리" });
  // 공통 모달: 오른쪽 위 X와 Esc로 닫히고, 다시 열 수 있다
  await expect(dlg.getByRole("button", { name: "닫기" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await page.getByRole("button", { name: "취소 · 환불" }).click();
  await expect(dlg).toBeVisible();
  const paid = Number((await dlg.locator("dt", { hasText: "결제 금액" }).locator("+ dd").innerText()).replace(/[^0-9]/g, ""));
  // 사유 주체를 고르기 전: 발송 전 전체 취소는 두 사유 주체의 금액이 같아 바로 보인다
  await expect(dlg.getByTestId("refund-reward")).toHaveText("1,000원 · 적립금으로 반환");
  await expect(dlg.getByTestId("refund-amount")).toHaveText(`${paid.toLocaleString("ko-KR")}원`);
  await expect(dlg).toContainText("쓴 적립금은 구매자에게 적립금으로 돌려줍니다");
  await dlg.getByRole("radio", { name: /파트너스 사정/ }).check();
  await expect(dlg.getByTestId("refund-reward")).toHaveText("1,000원 · 적립금으로 반환");
  await dlg.getByLabel("처리 사유").selectOption("품절 · 재고 없음");
  await dlg.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.").check();
  await page.screenshot({ path: "tests/e2e/screenshots/SA-023-reward-1440.png" });
  const refund = page.waitForResponse((r) => r.url().endsWith("/refund") && r.request().method() === "POST");
  await dlg.getByRole("button", { name: /환불 실행/ }).click();
  const res = await refund;
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { refundAmount: number }).refundAmount).toBe(paid);
  // 쓴 적립금 전부가 구매자에게 돌아갔다
  expect(await rewardBalanceInDb(SLUG, BUYER)).toBe(5000);
});

test("일부 상품만 환불: 수량을 골라 미리보기(현금·적립금·배송비·회수)를 보고, 남은 상품은 마지막 환불로 배송비까지 돌려받는다", async ({ page, baseURL, playwright }) => {
  test.setTimeout(120_000);
  await allowRewardUseInDb(SLUG, BUYER, 5000);
  const orderId = await paidOrder(page, baseURL!, playwright, [
    { product: "문라이트 컬렉션 박스", quantity: 1 },
    { product: "스타라이트 부스터 박스", option: "낱개 1팩", quantity: 1 },
  ]);
  await page.goto(`/seller/orders/${orderId}`);
  await page.getByRole("button", { name: "취소 · 환불" }).click();
  const dlg = page.getByRole("dialog", { name: "취소 · 환불 처리" });
  const paid = Number((await dlg.locator("dt", { hasText: "결제 금액" }).locator("+ dd").innerText()).replace(/[^0-9]/g, ""));

  // 일부 상품만: 상품을 고르지 않으면 환불할 수 없다
  await dlg.getByRole("radio", { name: /일부 상품만/ }).check();
  await expect(dlg.getByText("환불할 상품을 골라 주십시오")).toBeVisible();
  await dlg.getByRole("radio", { name: /파트너스 사정/ }).check();
  await dlg.getByLabel("처리 사유").selectOption("품절 · 재고 없음");
  await expect(dlg.getByRole("button", { name: /환불 실행/ })).toHaveCount(0);
  // 두 상품(132,000 + 6,000) 중 첫 상품만(개봉 대기 품목은 수량 전부만): 적립금 반환 = 1,000 × 132,000 ÷ 138,000 = 956 → 10원 단위 내림 950 · 현금 = 132,000 − 950 · 배송비는 마지막 환불에서
  await dlg.getByRole("checkbox", { name: /문라이트 컬렉션 박스.*선택/ }).check();
  await expect(dlg.getByLabel("문라이트 컬렉션 박스 1박스 환불 수량")).toBeDisabled();
  await expect(dlg.getByTestId("refund-items-amount")).toHaveText("132,000원");
  await expect(dlg.getByTestId("refund-reward")).toHaveText("950원 · 적립금으로 반환");
  await expect(dlg.getByTestId("refund-amount")).toHaveText("131,050원");
  await expect(dlg.getByTestId("refund-shipping")).toHaveText("마지막 환불에서 돌려줍니다");
  await expect(dlg.getByTestId("refund-final")).toContainText("주문은 결제 완료로 남고");
  await page.screenshot({ path: "tests/e2e/screenshots/SA-023-partial-1440.png" });
  await dlg.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.").check();
  const first = page.waitForResponse((r) => r.url().endsWith("/refund") && r.request().method() === "POST");
  await dlg.getByRole("button", { name: /환불 실행/ }).click();
  const r1 = await first;
  expect(r1.status()).toBe(200);
  const b1 = (await r1.json()) as { refundAmount: number; isFinal: boolean };
  expect(b1.refundAmount).toBe(131_050);
  expect(b1.isFinal).toBe(false);
  expect(await rewardBalanceInDb(SLUG, BUYER)).toBe(5000 - REWARD + 950);

  // 주문은 결제 완료로 남고, 다시 열면 이미 환불한 금액과 남은 1개가 보인다 → 마지막 환불: 남은 적립금 50·배송비까지
  await page.goto(`/seller/orders/${orderId}`);
  await page.getByRole("button", { name: "취소 · 환불" }).click();
  await expect(dlg.getByText("남은 상품 전부 환불")).toBeVisible();
  await dlg.getByRole("radio", { name: /파트너스 사정/ }).check();
  await dlg.getByLabel("처리 사유").selectOption("품절 · 재고 없음");
  await expect(dlg.getByText("이미 환불한 금액")).toBeVisible();
  await expect(dlg.getByTestId("refund-reward")).toHaveText("50원 · 적립금으로 반환");
  const rest = paid - 131_050;
  await expect(dlg.getByTestId("refund-amount")).toHaveText(`${rest.toLocaleString("ko-KR")}원`);
  await dlg.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.").check();
  const last = page.waitForResponse((r) => r.url().endsWith("/refund") && r.request().method() === "POST");
  await dlg.getByRole("button", { name: /환불 실행/ }).click();
  const r2 = await last;
  expect(r2.status()).toBe(200);
  expect(((await r2.json()) as { isFinal: boolean }).isFinal).toBe(true);
  expect(await rewardBalanceInDb(SLUG, BUYER)).toBe(5000);
});

test("일부 상품만 환불: 「개봉 확인」은 고른 상품 중 개봉한 것이 있을 때만 요구한다", async ({ page, baseURL, playwright }) => {
  test.setTimeout(90_000);
  await allowRewardUseInDb(SLUG, BUYER, 5000);
  const orderId = await paidOrder(page, baseURL!, playwright, [
    { product: "문라이트 컬렉션 박스", quantity: 1 },
    { product: "스타라이트 부스터 박스", option: "낱개 1팩", quantity: 1 },
  ]);
  await markItemOpenedInDb(orderId, "스타라이트 부스터 박스");
  await page.goto(`/seller/orders/${orderId}`);
  await page.getByRole("button", { name: "취소 · 환불" }).click();
  const dlg = page.getByRole("dialog", { name: "취소 · 환불 처리" });
  const opened = dlg.getByLabel("개봉한 상품이 있는 것을 확인했습니다");
  await dlg.getByRole("radio", { name: /파트너스 사정/ }).check();
  await dlg.getByLabel("처리 사유").selectOption("품절 · 재고 없음");
  // 전체 환불에는 개봉한 상품이 들어 있어 확인이 필요하다
  await expect(opened).toBeVisible();
  // 일부 상품만: 개봉하지 않은 상품만 고르면 확인 없이 환불할 수 있다
  await dlg.getByRole("radio", { name: /일부 상품만/ }).check();
  await dlg.getByRole("checkbox", { name: /문라이트 컬렉션 박스.*선택/ }).check();
  await expect(dlg.getByTestId("refund-items-amount")).toHaveText("132,000원");
  await expect(opened).toHaveCount(0);
  await dlg.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.").check();
  await expect(dlg.getByRole("button", { name: /환불 실행/ })).toBeEnabled();
  // 개봉한 상품을 고르면 확인이 나타나고, 체크해야 환불할 수 있다
  await dlg.getByRole("checkbox", { name: /스타라이트 부스터 박스.*선택/ }).check();
  await expect(opened).toBeVisible();
  await expect(dlg.getByRole("button", { name: /환불 실행/ })).toBeDisabled();
});
