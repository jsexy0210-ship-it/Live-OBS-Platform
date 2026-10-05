import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, markOrderPaidInDb, rejectRefundRequestInDb, resetCartInDb } from "./cartDb";

// SH-022 주문 취소(환불) 요청(운영 빌드 + 데모 시드). 데모 구매자로 주문을 만들어 결제 완료로 바꾼 뒤 요청·거절·철회를 화면에서 확인하고 끝에 지운다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const since = new Date(Date.now() - 60_000);

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
async function optionOf(page: Page, name: string) {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  const pid = list.products.find((p) => p.name === name)!.id;
  return ((await (await page.request.get(`/api/shop/${SLUG}/products/${pid}`)).json()) as { product: { options: { id: string }[] } }).product.options[0].id;
}
// 탑로더 25장 2개 + 문라이트 컬렉션 박스 1개 주문
async function makeOrder(page: Page, baseURL: string, paid: boolean) {
  const consent = ((await (await page.request.get(`/api/shop/${SLUG}/order-consent`)).json()) as { consents: { version: string }[] }).consents[0].version;
  const r = await page.request.post(`/api/shop/${SLUG}/orders`, {
    headers: { origin: baseURL },
    data: {
      items: [
        { optionId: await optionOf(page, "탑로더 25장"), quantity: 2 },
        { optionId: await optionOf(page, "문라이트 컬렉션 박스"), quantity: 1 },
      ],
      consent: { agreed: true, noticeVersion: consent },
      shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12" },
      saveAddress: false,
    },
  });
  expect(r.ok()).toBe(true);
  const { orderId } = (await r.json()) as { orderId: string };
  if (paid) await markOrderPaidInDb(orderId);
  return orderId;
}

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  await deleteBuyerOrdersSince(SLUG, LOGIN, since);
  await resetCartInDb(SLUG, LOGIN, []);
});

test("결제 대기 주문에는 취소 요청이 보이지 않는다(요청은 결제 완료·발송 전 주문만)", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const id = await makeOrder(page, baseURL!, false);
  await page.goto(`/shop/${SLUG}/orders/${id}`);
  await expect(page.getByRole("heading", { name: "결제", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "주문 취소 요청" })).toHaveCount(0);
});

test("PC: 주문 취소 요청(품목·사유 검사) → 요청 중 표시 → 철회 → 다시 요청 → 거절 사유 보임", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, baseURL!);
  const id = await makeOrder(page, baseURL!, true);
  await page.goto(`/shop/${SLUG}/orders/${id}`);
  const box = page.getByRole("region", { name: "주문 취소 요청" });
  await expect(box.getByRole("button", { name: "주문 취소 요청" })).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/SH-022-refund-1440.png", fullPage: true });
  await box.getByRole("button", { name: "주문 취소 요청" }).click();
  const dlg = page.getByRole("dialog", { name: "주문을 취소할까요?" });
  await expect(dlg).toContainText("개봉 전까지만 취소할 수 있어요");
  await expect(dlg.getByRole("checkbox", { name: /탑로더 25장/ })).toBeChecked(); // 기본은 남은 품목 전부
  await expect(dlg.getByRole("checkbox", { name: /문라이트 컬렉션 박스/ })).toBeChecked();
  await expect(dlg.getByLabel("사유")).toHaveValue("CHANGE_OF_MIND"); // 기본 사유
  // 검사: 기타는 자세한 사유 필수, 품목은 하나 이상
  await dlg.getByLabel("사유").selectOption("OTHER");
  await dlg.getByRole("button", { name: "취소 요청" }).click();
  await expect(dlg.getByRole("alert")).toHaveText("자세한 사유를 적어 주세요");
  await dlg.getByLabel("자세한 사유").fill("방송 시간이 바뀌어서요");
  await dlg.getByRole("checkbox", { name: /탑로더 25장/ }).uncheck();
  await dlg.getByRole("checkbox", { name: /문라이트 컬렉션 박스/ }).uncheck();
  await dlg.getByRole("button", { name: "취소 요청" }).click();
  await expect(dlg.getByRole("alert")).toHaveText("환불받을 상품을 하나 이상 골라 주세요");
  await dlg.getByRole("checkbox", { name: /문라이트 컬렉션 박스/ }).check(); // 일부 품목만
  await page.screenshot({ path: "tests/e2e/screenshots/SH-022-refund-modal-1440.png" });
  await dlg.getByRole("button", { name: "취소 요청" }).click();
  await expect(dlg).toBeHidden();
  await expect(box.getByRole("status")).toContainText("요청했어요");
  const row = box.getByTestId("refund-request");
  await expect(row).toContainText("취소 요청 · 기타");
  await expect(row).toContainText("방송 시간이 바뀌어서요");
  await expect(row).toContainText("판매자가 확인하면 바로 환불돼요");
  await expect(box.getByRole("button", { name: "주문 취소 요청" })).toHaveCount(0); // 진행 중인 요청이 있으면 다시 못 함
  await expect(box).toContainText("진행 중인 요청이 끝나면 다시 요청할 수 있어요");
  // 철회
  await row.getByRole("button", { name: "요청 철회" }).click();
  await expect(box.getByRole("status")).toContainText("요청을 철회했어요");
  await expect(box.getByTestId("refund-request").first()).toContainText("철회했어요");
  await expect(box.getByRole("button", { name: "주문 취소 요청" })).toBeVisible();
  // 다시 요청 → 판매자가 거절하면 사유가 보인다
  await box.getByRole("button", { name: "주문 취소 요청" }).click();
  await page.getByRole("dialog", { name: "주문을 취소할까요?" }).getByRole("button", { name: "취소 요청" }).click(); // 기본값(전부·단순 변심)
  await expect(box.getByTestId("refund-request").first()).toContainText("취소 요청 · 단순 변심");
  await rejectRefundRequestInDb(id, "이미 포장을 시작했어요");
  await page.reload();
  await expect(page.getByRole("region", { name: "주문 취소 요청" }).getByTestId("refund-request").first()).toContainText("거절됐어요");
  await expect(page.getByRole("region", { name: "주문 취소 요청" })).toContainText("거절 사유 · 이미 포장을 시작했어요");
  await expect(page.getByRole("region", { name: "주문 취소 요청" }).getByRole("button", { name: "주문 취소 요청" })).toBeVisible(); // 거절 뒤엔 다시 요청 가능
});

test("휴대폰 390: 취소 요청 창·영역 가로 스크롤 없음", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, baseURL!);
  const id = await makeOrder(page, baseURL!, true);
  await page.goto(`/shop/${SLUG}/orders/${id}`);
  await page.getByRole("region", { name: "주문 취소 요청" }).getByRole("button", { name: "주문 취소 요청" }).click();
  await expect(page.getByRole("dialog", { name: "주문을 취소할까요?" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-022-refund-390.png" });
});
