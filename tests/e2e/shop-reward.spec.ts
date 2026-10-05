import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, orderRewardInDb, resetCartInDb, restoreRewardUse, rewardBalanceInDb, setRewardUseInDb, type RewardSnapshot } from "./cartDb";

// 주문서 적립금 사용(운영 빌드 + 데모 시드). 판매자 적립금 사용을 켜고 데모 구매자 잔액을 32,400원으로 정해 두고, 끝에 되돌린다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const since = new Date(Date.now() - 60_000);
let prev: RewardSnapshot;

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
// 탑로더 25장(6,000원) 1개를 담고 주문서를 열어 배송지·동의를 채운다
async function openCheckout(page: Page, baseURL: string) {
  await login(page, baseURL);
  await resetCartInDb(SLUG, LOGIN, [{ productName: "탑로더 25장", quantity: 1 }]);
  const cart = (await (await page.request.get(`/api/shop/${SLUG}/cart`)).json()) as { items: { id: string }[] };
  await page.goto(`/shop/${SLUG}/checkout?ids=${cart.items[0].id}`);
  await expect(page.getByRole("heading", { name: "주문서", level: 1 })).toBeVisible();
  await page.getByRole("radio", { name: /새 배송지 입력/ }).or(page.getByLabel("받는 분")).first().waitFor(); // 배송지 영역이 그려질 때까지
  if (await page.getByRole("radio", { name: /새 배송지 입력/ }).count()) await page.getByRole("radio", { name: /새 배송지 입력/ }).check();
  await page.getByLabel("받는 분").fill("김별빛");
  await page.getByLabel("연락처").fill("01012345678");
  await page.getByLabel("우편번호").fill("06234");
  await page.getByLabel("주소", { exact: true }).fill("서울 강남구 테스트로 12");
  await page.getByRole("checkbox", { name: /\(필수\)/ }).check();
}

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  prev = await setRewardUseInDb(SLUG, LOGIN, true, 32_400);
});
test.afterAll(async () => {
  await deleteBuyerOrdersSince(SLUG, LOGIN, since);
  await resetCartInDb(SLUG, LOGIN, []);
  await restoreRewardUse(SLUG, LOGIN, prev);
});

test.describe.serial("적립금 사용", () => {
  test("PC: 보유 적립금·기본 0·입력 오류 3종·전액 사용 → 적립금 쓴 실제 주문, 주문 상세에 적립금 사용 줄", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCheckout(page, baseURL!);
    const box = page.getByRole("region", { name: "적립금" });
    await expect(box).toContainText("보유 적립금");
    await expect(box).toContainText("32,400원");
    const input = box.getByLabel("사용할 적립금");
    await expect(input).toHaveValue("0"); // 기본은 쓰지 않음(0)
    const sum = page.getByRole("complementary", { name: "주문 금액" });
    await expect(sum.locator(".cart-row", { hasText: "적립금 사용" })).toHaveCount(0);
    // 입력 오류: 단위·한도(상품 금액)·잔액
    await input.fill("500");
    await expect(box.getByRole("alert")).toHaveText("적립금은 1,000원부터 10원 단위로 쓸 수 있어요");
    await input.fill("1005");
    await expect(box.getByRole("alert")).toHaveText("적립금은 1,000원부터 10원 단위로 쓸 수 있어요");
    await input.fill("10000");
    await expect(box.getByRole("alert")).toHaveText("적립금은 상품 금액까지만 쓸 수 있어요. 배송비에는 쓸 수 없어요");
    await input.fill("40000");
    await expect(box.getByRole("alert")).toHaveText("적립금이 부족해요");
    await page.getByRole("button", { name: "주문하기" }).click();
    await expect(page).toHaveURL(/\/checkout\?ids=/); // 오류가 있으면 주문하지 않는다
    // 전액 사용: 보유 적립금과 상품 금액 중 작은 값(6,000원), 배송비는 그대로 결제(배송비 계산이 끝난 뒤)
    await expect(sum.locator(".cart-row", { hasText: "결제 예정 금액" })).toBeVisible();
    await input.fill("0");
    await box.getByRole("button", { name: "전액 사용" }).click();
    await expect(input).toHaveValue("6,000");
    await expect(box.getByRole("alert")).toHaveCount(0);
    await expect(sum.locator(".cart-row", { hasText: "적립금 사용" })).toContainText("−6,000원");
    const fee = Number((await sum.locator(".cart-row", { hasText: "배송비" }).innerText()).replace(/[^0-9]/g, "") || "0");
    await expect(sum.locator(".cart-row", { hasText: "결제 예정 금액" }).locator("b")).toHaveText(`${(fee).toLocaleString("ko-KR")}원`);
    await page.screenshot({ path: "tests/e2e/screenshots/SH-005-reward-1440.png", fullPage: true });
    await page.getByRole("button", { name: "주문하기" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+\?done=1$/);
    const orderId = page.url().match(/\/orders\/([0-9a-f-]+)\?done=1/)![1];
    expect(await orderRewardInDb(orderId)).toEqual({ rewardUsedAmount: 6000, totalAmount: fee });
    expect(await rewardBalanceInDb(SLUG, LOGIN)).toBe(26_400); // 쓴 만큼 잔액에서 빠짐
    const pay = page.getByRole("region", { name: "결제 금액" });
    await expect(pay.locator(".cart-row", { hasText: "적립금 사용" })).toContainText("−6,000원");
    await expect(pay.locator(".cart-row", { hasText: "결제 금액" }).locator("b")).toHaveText(`${fee.toLocaleString("ko-KR")}원`);
    await page.screenshot({ path: "tests/e2e/screenshots/SH-007-reward-1440.png", fullPage: true });
  });

  test("서버 거부 4종: 형식·한도 초과·잔액 부족은 입력 칸 오류, 판매자가 쓸 수 없게 바꾼 경우는 영역이 사라지고 안내", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // 실제 서버 문구(주문 API): 형식·한도 초과·잔액 부족
    await login(page, baseURL!);
    const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
    const pid = list.products.find((p) => p.name === "탑로더 25장")!.id;
    const optionId = ((await (await page.request.get(`/api/shop/${SLUG}/products/${pid}`)).json()) as { product: { options: { id: string }[] } }).product.options[0].id;
    const consent = ((await (await page.request.get(`/api/shop/${SLUG}/order-consent`)).json()) as { consents: { version: string }[] }).consents[0].version;
    const place = async (reward: number) =>
      (
        await page.request.post(`/api/shop/${SLUG}/orders`, {
          headers: { origin: baseURL! },
          data: { items: [{ optionId, quantity: 1 }], consent: { agreed: true, noticeVersion: consent }, rewardUseAmount: reward, shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12" }, saveAddress: false },
        })
      ).json() as Promise<{ error?: string; message?: string }>;
    expect(await place(1005)).toMatchObject({ error: "invalid_reward_use", message: "적립금은 1,000원부터 10원 단위로 쓸 수 있어요" });
    expect(await place(8000)).toMatchObject({ error: "reward_use_over_limit", message: "적립금은 상품 금액까지만 쓸 수 있어요. 배송비에는 쓸 수 없어요" });
    // 화면: 서버가 거절하면 입력 칸 아래에 서버 문구
    await openCheckout(page, baseURL!);
    const box = page.getByRole("region", { name: "적립금" });
    await box.getByLabel("사용할 적립금").fill("2000");
    await setRewardUseInDb(SLUG, LOGIN, true, 0); // 화면을 연 뒤 잔액이 바뀜
    await page.getByRole("button", { name: "주문하기" }).click();
    await expect(box.getByRole("alert")).toHaveText("적립금이 부족해요");
    await expect(page).toHaveURL(/\/checkout\?ids=/);
    await setRewardUseInDb(SLUG, LOGIN, true, 32_400);
    // 형식·한도 초과 거절 문구도 같은 자리에 보인다(서버 응답 그대로)
    await page.route("**/api/shop/*/orders", (route) => route.request().method() === "POST" ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "reward_use_over_limit", message: "적립금은 상품 금액까지만 쓸 수 있어요. 배송비에는 쓸 수 없어요" }) }) : route.continue());
    await box.getByLabel("사용할 적립금").fill("2000");
    await page.getByRole("button", { name: "주문하기" }).click();
    await expect(box.getByRole("alert")).toHaveText("적립금은 상품 금액까지만 쓸 수 있어요. 배송비에는 쓸 수 없어요");
    await page.unroute("**/api/shop/*/orders");
    // 판매자가 적립금 사용을 꺼 둔 경우: 서버 거절 → 영역이 사라지고 안내, 적립금 없이 주문할 수 있다
    await setRewardUseInDb(SLUG, LOGIN, false, 32_400);
    await page.getByRole("button", { name: "주문하기" }).click();
    await expect(page.locator(".cart-msg.is-err")).toHaveText("이 쇼핑몰은 지금 적립금을 쓸 수 없어요"); // 서버 문구 그대로
    await expect(page.getByRole("region", { name: "적립금" })).toHaveCount(0);
    await page.screenshot({ path: "tests/e2e/screenshots/SH-005-reward-off-1440.png", fullPage: true });
    await page.getByRole("button", { name: "주문하기" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+\?done=1$/);
  });

  test("판매자가 적립금 사용을 꺼 두면 주문서에 적립금 영역·요약 줄이 처음부터 없다", async ({ page, baseURL }) => {
    await setRewardUseInDb(SLUG, LOGIN, false, 32_400);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openCheckout(page, baseURL!);
      await expect(page.getByRole("region", { name: "적립금" })).toHaveCount(0);
      await expect(page.getByRole("complementary", { name: "주문 금액" }).locator(".cart-row", { hasText: "적립금 사용" })).toHaveCount(0);
      await page.screenshot({ path: "tests/e2e/screenshots/SH-005-reward-hidden-1440.png", fullPage: true });
    } finally {
      await setRewardUseInDb(SLUG, LOGIN, true, 32_400);
    }
  });

  test("휴대폰 390: 적립금 칸 가로 스크롤 없음", async ({ page, baseURL }) => {
    await setRewardUseInDb(SLUG, LOGIN, true, 32_400);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCheckout(page, baseURL!);
    await expect(page.getByRole("region", { name: "적립금" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "tests/e2e/screenshots/SH-005-reward-390.png", fullPage: true });
  });
});
