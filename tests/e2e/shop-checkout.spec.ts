import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, orderNicknameInDb, resetCartInDb } from "./cartDb";
import { okConfirm } from "./shopConfirm";

// SH-005 주문서 · SH-007 주문 완료(운영 빌드 + 데모 시드). 데모 구매자(demo-buyer1@example.com)로 장바구니 → 주문서 → 주문(결제 대기)까지.
// 결제(PG·무통장)·적립금·배송비 미리보기는 서버 API가 아직 없어 이 시험 범위 밖이다. 시험이 만든 주문과 장바구니는 끝에 지운다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const STARTED = new Date();

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  await resetCartInDb(SLUG, LOGIN, []);
  await deleteBuyerOrdersSince(SLUG, LOGIN, STARTED);
});

test("주문서: ids 없음·비회원 안내", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/checkout`);
  await expect(page.getByText("주문할 상품을 장바구니에서 골라 주세요.")).toBeVisible();
  await expect(page.getByRole("link", { name: "장바구니로 가기" })).toHaveAttribute("href", `/shop/${SLUG}/cart`);
  await page.goto(`/shop/${SLUG}/checkout?ids=00000000-0000-4000-8000-000000000000`);
  await expect(page.getByText("로그인하면 주문할 수 있어요.")).toBeVisible();
});

test("장바구니 → 주문서(검사·동의) → 주문(결제 대기) → 주문 완료, 주문한 줄은 장바구니에서 빠진다", async ({ page, baseURL }) => {
  await resetCartInDb(SLUG, LOGIN, [
    { productName: "스타라이트 부스터 박스", quantity: 2 },
    { productName: "문라이트 컬렉션 박스", quantity: 1 },
    { productName: "드래곤 소울 부스터", quantity: 1 },
  ]);
  await login(page, baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/cart`);
  await page.getByRole("link", { name: /주문하기$/ }).click();
  await expect(page).toHaveURL(/\/checkout\?ids=.+,.+$/);
  await expect(page.getByRole("heading", { name: "주문서", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: /주문 상품/ }).getByText("스타라이트 부스터 박스")).toBeVisible();
  await expect(page.getByRole("region", { name: /주문 상품/ })).not.toContainText("드래곤 소울 부스터"); // 품절 줄은 빠진다
  const subtotal = ((await (await page.request.get(`/api/shop/${SLUG}/cart`)).json()) as { items: { status: string; lineTotal: number }[] }).items.filter((l) => l.status === "available").reduce((s, l) => s + l.lineTotal, 0);
  await expect(page.getByRole("complementary", { name: "주문 금액" }).locator(".cart-row b").first()).toHaveText(`${subtotal.toLocaleString("ko-KR")}원`);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-005-checkout-1440.png", fullPage: true });

  // 빈 칸·동의 안 함이면 오류가 보이고 주문은 만들어지지 않는다
  if (await page.getByRole("radio", { name: /새 배송지 입력/ }).count()) await page.getByRole("radio", { name: /새 배송지 입력/ }).check();
  await page.getByRole("button", { name: "주문하기" }).click();
  await expect(page.getByText("받는 분 이름을 적어 주세요")).toBeVisible();
  await expect(page.getByText("우편번호 5자리를 적어 주세요")).toBeVisible();
  await expect(page.getByText("‘주문 내용을 확인했어요’에 체크해 주세요")).toBeVisible();
  await expect(page).toHaveURL(/\/checkout\?ids=/);

  await page.getByLabel("받는 분").fill("김별빛");
  await page.getByLabel("연락처").fill("010-1234-5678");
  await page.getByLabel("우편번호").fill("06234");
  await page.getByLabel("주소", { exact: true }).fill("서울 강남구 테스트로 12");
  await page.getByLabel("상세 주소").fill("101동 1001호");
  // 배송비 미리보기: 우편번호·주소가 정해지면 서버 계산값(상품 금액 + 배송비)이 보이고, 제주·도서산간이면 표시가 붙는다
  const sum = page.getByRole("complementary", { name: "주문 금액" });
  await expect(sum.locator(".cart-row", { hasText: "배송비" })).toContainText("원");
  const fee = Number((await sum.locator(".cart-row", { hasText: "배송비" }).innerText()).replace(/[^0-9]/g, "").replace(/^$/, "0"));
  await expect(sum.locator(".cart-row", { hasText: "최종 결제 금액" }).locator("b")).toHaveText(`${(subtotal + fee).toLocaleString("ko-KR")}원`);
  await page.getByLabel("우편번호").fill("63000");
  await page.getByLabel("주소", { exact: true }).fill("제주특별자치도 제주시 테스트로 1");
  await expect(sum.locator(".cart-row", { hasText: "배송비" })).toContainText("제주·도서산간 포함");
  await page.getByLabel("우편번호").fill("06234");
  await page.getByLabel("주소", { exact: true }).fill("서울 강남구 테스트로 12");
  await expect(sum.locator(".cart-row", { hasText: "배송비" })).not.toContainText("제주");
  // 방송 닉네임: 기본값은 회원 방송 닉네임, 이 주문만 바꿀 수 있다(회원 닉네임은 그대로)
  const memberNick = ((await page.locator(".shop-util-who").innerText()) as string).replace(/ 님$/, "");
  await expect(page.getByLabel("이 주문의 닉네임")).toHaveValue(memberNick);
  await page.getByLabel("이 주문의 닉네임").fill("시험닉");
  await page.getByRole("checkbox", { name: /\(필수\)/ }).check();
  await page.getByRole("button", { name: "주문하기" }).click();
  await okConfirm(page, "주문하기");

  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+\?done=1&pay=card$/);
  await expect(page.getByRole("heading", { name: "주문 완료", level: 1 })).toBeVisible();
  expect(await orderNicknameInDb(page.url().match(/\/orders\/([0-9a-f-]+)\?done=1/)![1])).toBe("시험닉");
  await expect(page.locator(".shop-util-who")).toHaveText(`${memberNick} 님`); // 회원 닉네임은 그대로
  await expect(page.locator(".shop-hics .shop-badge")).toHaveText("1"); // 품절 줄 하나만 남아 머리 배지도 따라간다
  await expect(page.getByRole("status")).toContainText("주문이 접수됐어요");
  await expect(page.getByText("결제 전").first()).toBeVisible();
  await expect(page.getByRole("region", { name: /주문 상품/ })).toContainText("스타라이트 부스터 박스");
  await expect(page.getByRole("region", { name: "배송 정보" })).toContainText("서울 강남구 테스트로 12");
  await page.screenshot({ path: "tests/e2e/screenshots/SH-007-order-done-1440.png", fullPage: true });
  const left = ((await (await page.request.get(`/api/shop/${SLUG}/cart`)).json()) as { items: { productName: string }[] }).items.map((l) => l.productName);
  expect(left).toEqual(["드래곤 소울 부스터"]);
});

test("휴대폰 390: 주문서 가로 스크롤 없음", async ({ page, baseURL }) => {
  await resetCartInDb(SLUG, LOGIN, [{ productName: "스타라이트 부스터 박스", quantity: 1 }]);
  await login(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/shop/${SLUG}/cart`);
  await page.getByRole("link", { name: /주문하기$/ }).click();
  await expect(page.getByRole("heading", { name: "주문서", level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-005-checkout-390.png", fullPage: true });
});
