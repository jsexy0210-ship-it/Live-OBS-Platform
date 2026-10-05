import { expect, test } from "@playwright/test";
import { allowRewardUseInDb, deleteOrderInDb, liveVersionInDb, rewardBalanceInDb } from "./rewardDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-023 환불 창 「현금 환불 · 적립금 반환」: 실제로 적립금 1,000원을 쓴 주문(구매자 주문 → 무통장 → 입금 확인)을 파트너스 환불 창에서 열어
// 두 줄이 서버 계산대로 나오고, 환불하면 적립금이 구매자에게 돌아가는지 본다. 이 시험이 만든 주문은 끝에 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const BUYER = "demo-buyer1@example.com";
const REWARD = 1000;
let createdOrderId = "";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await allowRewardUseInDb(SLUG, BUYER, 5000);
});
test.afterAll(async () => {
  if (createdOrderId) await deleteOrderInDb(createdOrderId);
});

test("적립금을 쓴 주문의 환불 창: 현금 환불과 적립금 반환이 따로 보이고, 환불하면 적립금이 돌아간다", async ({ page, baseURL, playwright }) => {
  test.setTimeout(90_000);
  // 구매자: 적립금 1,000원을 쓰고 주문 → 무통장 선택
  const buyer = await playwright.request.newContext({ baseURL: baseURL! });
  const origin = { origin: baseURL! };
  expect((await buyer.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: BUYER, password: PASSWORD }, headers: origin })).status()).toBe(200);
  const list = (await (await buyer.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  const pid = list.products.find((p) => p.name === "문라이트 컬렉션 박스")!.id;
  const prod = (await (await buyer.get(`/api/shop/${SLUG}/products/${pid}`)).json()) as { product: { options: { id: string }[] } };
  const consent = (await (await buyer.get(`/api/shop/${SLUG}/order-consent`)).json()) as { consents: { version: string }[] };
  const o = await buyer.post(`/api/shop/${SLUG}/orders`, {
    headers: origin,
    data: {
      items: [{ optionId: prod.product.options[0].id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: consent.consents[0].version },
      rewardUseAmount: REWARD,
      shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12" },
      saveAddress: false,
    },
  });
  expect(o.ok(), await o.text()).toBe(true);
  const { orderId } = (await o.json()) as { orderId: string };
  createdOrderId = orderId;
  expect((await buyer.post(`/api/shop/${SLUG}/payments/bank-transfer`, { data: { orderId }, headers: origin })).status()).toBe(200);
  expect(await rewardBalanceInDb(SLUG, BUYER)).toBe(5000 - REWARD);

  // 파트너스: 입금 확인 → 주문 상세 → 환불 창
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
