import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, markOrderCancelledInDb, resetCartInDb } from "./cartDb";

// SH-021 주문 내역(운영 빌드 + 데모 시드). 데모 구매자(demo-buyer1@example.com)로 주문을 하나 만들어 목록에서 확인하고 끝에 지운다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const since = new Date(Date.now() - 60_000);

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
async function makeOrder(page: Page, baseURL: string) {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  const pid = list.products.find((p) => p.name === "탑로더 25장")!.id;
  const product = (await (await page.request.get(`/api/shop/${SLUG}/products/${pid}`)).json()) as { product: { options: { id: string }[] } };
  const consent = (await (await page.request.get(`/api/shop/${SLUG}/order-consent`)).json()) as { consents: { version: string }[] };
  const r = await page.request.post(`/api/shop/${SLUG}/orders`, {
    headers: { origin: baseURL },
    data: {
      items: [{ optionId: product.product.options[0].id, quantity: 2 }],
      consent: { agreed: true, noticeVersion: consent.consents[0].version },
      shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12" },
      saveAddress: false,
    },
  });
  expect(r.ok()).toBe(true);
  const { orderId } = (await r.json()) as { orderId: string };
  const o = (await (await page.request.get(`/api/shop/${SLUG}/orders/${orderId}`)).json()) as { orderNoLabel: string };
  return { orderId, orderNo: o.orderNoLabel };
}

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  await deleteBuyerOrdersSince(SLUG, LOGIN, since);
  await resetCartInDb(SLUG, LOGIN, []);
});

test("비회원: 로그인 안내", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/orders`);
  await expect(page.getByText("로그인하면 주문 내역을 볼 수 있어요.")).toBeVisible();
  await expect(page.getByRole("link", { name: "로그인", exact: true }).last()).toHaveAttribute("href", /\/login\?next=/);
});

test("PC: 주문 내역 표(열 제목 가운데·값 왼쪽)·상태 탭·결제하기 → 주문 상세", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, baseURL!);
  const { orderId, orderNo } = await makeOrder(page, baseURL!);
  await page.goto(`/shop/${SLUG}/orders`);
  await expect(page.getByRole("heading", { name: "주문 내역", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "내 정보 메뉴" }).getByRole("link", { name: "주문 내역" })).toHaveAttribute("aria-current", "page");
  const table = page.getByRole("table", { name: "주문 내역" });
  await expect(table.locator("thead th")).toHaveText(["주문일 · 번호", "상품 정보", "상태", "관리"]);
  expect(await table.locator("th").first().evaluate((el) => getComputedStyle(el).textAlign)).toBe("center"); // 열 제목은 가운데
  const row = table.locator("tbody tr", { has: page.getByRole("link", { name: orderNo, exact: true }) });
  expect(await row.locator("td").nth(1).evaluate((el) => getComputedStyle(el).textAlign)).toBe("left"); // 값은 왼쪽
  await expect(row).toContainText("탑로더 25장");
  await expect(row).toContainText("옵션: 1팩 · 수량 2개");
  await expect(row).toContainText("결제 전");
  await page.screenshot({ path: "tests/e2e/screenshots/SH-021-orders-1440.png" });
  // 탭 6개(보드 SH-021-IA): 전체 · 결제 전 · 진행 중 · 완료 · 취소 · 환불
  const tabNames = (await page.getByRole("tab").allInnerTexts()).map((t) => t.replace(/\s*\d+$/, "").trim());
  expect(tabNames).toEqual(["전체", "결제 전", "진행 중", "완료", "취소", "환불"]);
  // 기간 칩(3개월 · 6개월 · 1년): 처음은 3개월이고 한 번에 하나만 눌린다. 탭 개수는 서버가 센 값이다
  const chips = page.getByRole("group", { name: "조회 기간" }).getByRole("button");
  await expect(chips).toHaveText(["3개월", "6개월", "1년"]);
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");
  const apiAll = (await (await page.request.get(`/api/shop/${SLUG}/orders?tab=all&limit=1`)).json()) as { counts: { all: number; pending: number } };
  await expect(page.getByRole("tab", { name: /^전체/ })).toContainText(String(apiAll.counts.all));
  await expect(page.getByRole("tab", { name: /^결제 전/ })).toContainText(String(apiAll.counts.pending));
  await chips.nth(2).click();
  await expect(chips.nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "false");
  await expect(table.getByRole("link", { name: orderNo, exact: true })).toBeVisible();
  await chips.nth(0).click();
  // 탭: 결제 전에는 있고 취소에는 없다
  await page.getByRole("tab", { name: /^결제 전/ }).click();
  await expect(table.getByRole("link", { name: orderNo, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^취소/ }).click();
  await expect(page.getByRole("link", { name: orderNo, exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: /^결제 전/ }).click();
  await row.getByRole("link", { name: "결제하기" }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
  await expect(page.getByRole("region", { name: "결제", exact: true })).toBeVisible();
});

test("휴대폰 390: 주문 내역 가로 스크롤 없음", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, baseURL!);
  await makeOrder(page, baseURL!);
  await page.goto(`/shop/${SLUG}/orders`);
  await expect(page.getByRole("table", { name: "주문 내역" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-021-orders-390.png", fullPage: true });
});

test("서버 값 연결: 개봉 대기(앞에 N명)·개봉 중 라벨, 취소한 주문은 「다시 담기」로 장바구니에 담는다", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, baseURL!);
  const { orderId, orderNo } = await makeOrder(page, baseURL!);
  // 서버 응답 모양(#717)대로 대기열 요약을 얹어 라벨을 확인한다: 결제 완료 + queue
  let queue: { status: string; aheadCount: number } = { status: "WAITING", aheadCount: 11 };
  await page.route("**/api/shop/*/orders?**", async (route) => {
    const res = await route.fetch();
    const j = (await res.json()) as { orders: { id: string; status: string; queue: unknown }[] };
    for (const o of j.orders) if (o.id === orderId) Object.assign(o, { status: "PAID", queue });
    await route.fulfill({ response: res, json: j });
  });
  await page.goto(`/shop/${SLUG}/orders`);
  const row = page.getByRole("table", { name: "주문 내역" }).locator("tbody tr", { has: page.getByRole("link", { name: orderNo, exact: true }) });
  await expect(row.locator(".ol-tag")).toHaveText("개봉 대기");
  await expect(row).toContainText("앞에 11명");
  queue = { status: "OPENING", aheadCount: 0 };
  await page.reload();
  await expect(row.locator(".ol-tag")).toHaveText("개봉 중");
  await page.unroute("**/api/shop/*/orders?**");

  // 취소한 주문: 「취소」 탭에 보이고 「다시 담기」로 같은 상품·수량을 장바구니에 담는다
  await resetCartInDb(SLUG, LOGIN, []);
  await markOrderCancelledInDb(orderId);
  await page.goto(`/shop/${SLUG}/orders`);
  await page.getByRole("tab", { name: /^취소/ }).click();
  const cancelled = page.getByRole("table", { name: "주문 내역" }).locator("tbody tr", { has: page.getByRole("link", { name: orderNo, exact: true }) });
  await expect(cancelled.locator(".ol-tag")).toHaveText("취소했어요");
  await cancelled.getByRole("button", { name: "다시 담기" }).click();
  await expect(page.getByRole("status")).toContainText("1개 상품을 장바구니에 담았어요");
  await page.getByRole("link", { name: "장바구니 보기" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/cart$`));
  await expect(page.locator(".cart-tbl tbody tr")).toHaveCount(1);
  await expect(page.locator(".cart-tbl tbody tr").first()).toContainText("탑로더 25장");
});
