import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, resetCartInDb } from "./cartDb";
import { okConfirm } from "./shopConfirm";

// 구매자 확인 창(DS-CONFIRM 구매자): 주문하기·결제하기 같은 되돌리기 어려운 행동은 확인 창을 거치고, 취소하면 서버에 아무것도 보내지 않는다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const STARTED = new Date();

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  await resetCartInDb(SLUG, LOGIN, []);
  await deleteBuyerOrdersSince(SLUG, LOGIN, STARTED);
});

async function fillCheckout(page: Page, baseURL: string) {
  await resetCartInDb(SLUG, LOGIN, [{ productName: "탑로더 25장", quantity: 1 }]);
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
  await page.goto(`/shop/${SLUG}/cart`);
  await page.getByRole("link", { name: /주문하기$/ }).click();
  await expect(page.getByRole("heading", { name: "주문서", level: 1 })).toBeVisible();
  await page.getByRole("radio", { name: /새 배송지 입력/ }).or(page.getByLabel("받는 분")).first().waitFor(); // 배송지 영역이 뜰 때까지
  if (await page.getByRole("radio", { name: /새 배송지 입력/ }).count()) await page.getByRole("radio", { name: /새 배송지 입력/ }).check();
  await page.getByLabel("받는 분").fill("김별빛");
  await page.getByLabel("연락처").fill("010-1234-5678");
  await page.getByLabel("우편번호").fill("06234");
  await page.getByLabel("주소", { exact: true }).fill("서울 강남구 테스트로 12");
  await page.getByRole("checkbox", { name: /\(필수\)/ }).check();
}

test("PC: 주문하기는 확인 창을 거치고, 취소하면 주문이 만들어지지 않는다", async ({ page, baseURL }) => {
  await fillCheckout(page, baseURL!);
  let posts = 0;
  await page.route("**/api/shop/*/orders", (route) => {
    if (route.request().method() === "POST") posts += 1;
    return route.continue();
  });
  await page.getByRole("button", { name: "주문하기" }).click();
  const dlg = page.getByRole("dialog", { name: "주문할까요?" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("1개 상품");
  await expect(dlg).toContainText("결제는 다음 화면에서 해요");
  await expect(dlg.getByRole("button", { name: "취소" })).toBeFocused(); // 열리면 취소로 포커스
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page).toHaveURL(/\/checkout\?ids=/);
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "주문하기" }).click();
  await page.keyboard.press("Escape"); // Esc도 취소
  await expect(dlg).toHaveCount(0);
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "주문하기" }).click();
  await okConfirm(page, "주문하기");
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+\?done=1&pay=card$/);
  expect(posts).toBe(1);

  // 결제하기도 확인 창 → 취소하면 결제를 시작하지 않는다
  let pays = 0;
  await page.route("**/api/shop/*/payments", (route) => {
    pays += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "payment_not_ready", message: "결제를 준비하고 있어요" }) });
  });
  await page.getByRole("button", { name: /결제하기$/ }).click();
  const pdlg = page.getByRole("dialog", { name: /원을 결제할까요\?/ });
  await expect(pdlg).toBeVisible();
  await expect(pdlg).toContainText("카드 결제 창이 열려요");
  await pdlg.getByRole("button", { name: "취소" }).click();
  expect(pays).toBe(0);
});

test("휴대폰 390: 확인 창은 아래에서 올라오는 시트로 열린다", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fillCheckout(page, baseURL!);
  await page.getByRole("button", { name: "주문하기" }).click();
  await expect(page.getByRole("dialog", { name: "주문할까요?" })).toBeVisible();
  await expect(page.locator(".ui-modal-bg.is-sheet")).toHaveCount(1);
  const r = await page.locator(".confirm-dialog").evaluate((el) => { const b = el.getBoundingClientRect(); return { bottom: b.bottom, vh: window.innerHeight, w: b.width }; });
  expect(Math.round(r.bottom)).toBe(r.vh);
  expect(r.w).toBeLessThanOrEqual(390);
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: "tests/e2e/screenshots/SH-005-confirm-390.png" });
});

test("PC 1440: 확인 창 증거", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fillCheckout(page, baseURL!);
  await page.getByRole("button", { name: "주문하기" }).click();
  await expect(page.getByRole("dialog", { name: "주문할까요?" })).toBeVisible();
  if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: "tests/e2e/screenshots/SH-005-confirm-1440.png" });
});

test("장바구니 삭제·로그아웃은 확인 창을 거치고, 취소하면 아무것도 바뀌지 않는다", async ({ page, baseURL }) => {
  await resetCartInDb(SLUG, LOGIN, [{ productName: "탑로더 25장", quantity: 1 }]);
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  let deletes = 0;
  let logouts = 0;
  await page.route("**/api/shop/*/cart/**", (route) => {
    if (route.request().method() === "DELETE") deletes += 1;
    return route.continue();
  });
  await page.route("**/api/shop/*/auth/logout", (route) => {
    logouts += 1;
    return route.continue();
  });
  await page.goto(`/shop/${SLUG}/cart`);
  const rows = page.locator(".cart-tbl tbody tr");
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole("button", { name: "삭제" }).click();
  const dlg = page.getByRole("dialog", { name: "이 상품을 뺄까요?" });
  await expect(dlg).toContainText("장바구니에서만 빠져요.");
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(rows).toHaveCount(1);
  expect(deletes).toBe(0);

  await page.locator(".shop-util").getByRole("button", { name: "로그아웃" }).click();
  const out = page.getByRole("dialog", { name: "로그아웃할까요?" });
  await expect(out).toContainText("이 기기에서 로그아웃돼요");
  await out.getByRole("button", { name: "취소" }).click();
  expect(logouts).toBe(0);
  await expect(page.locator(".shop-util").getByRole("link", { name: "내 정보" })).toBeVisible();

  await rows.first().getByRole("button", { name: "삭제" }).click();
  await okConfirm(page, "빼기");
  await expect(page.getByRole("heading", { name: "장바구니가 비어 있어요" })).toBeVisible();
  expect(deletes).toBe(1);
});
