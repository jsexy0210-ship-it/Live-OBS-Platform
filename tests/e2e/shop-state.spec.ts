import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, resetCartInDb, setOperatingState } from "./cartDb";

// 보드 SH-040 v313: 준비 중 「곧 문을 열어요」 · 일시 정지 「지금은 잠시 쉬고 있어요」 · 내 주문 보기 · 결제 기다리는 주문 · 로그인 전.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const since = new Date(Date.now() - 60_000);

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterEach(async () => {
  await setOperatingState(SLUG, "OPEN");
});
test.afterAll(async () => {
  await deleteBuyerOrdersSince(SLUG, LOGIN, since);
  await resetCartInDb(SLUG, LOGIN, []);
});

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

test("준비 중: 홈·상품·장바구니·회원가입 주소 모두 안내 화면, 머리에 회원가입 없음, 로그인 전에는 로그인하기", async ({ page }) => {
  await setOperatingState(SLUG, "PREPARING");
  for (const path of ["", "/products", "/cart", "/signup"]) {
    await page.goto(`/shop/${SLUG}${path}`);
    await expect(page.getByRole("heading", { name: "곧 문을 열어요", level: 1 })).toBeVisible();
  }
  const card = page.locator(".shop-state");
  await expect(card).toContainText("카드숍 별빛이 문 열 준비를 하고 있어요.");
  await expect(card).toContainText("이미 주문한 내역은 확인할 수 있어요.");
  await expect(card).toContainText("새 주문 · 장바구니 · 회원가입은 문을 열면 할 수 있어요");
  await expect(card).toContainText("내 주문은 로그인한 뒤 볼 수 있어요");
  await expect(card.getByRole("link", { name: "로그인하기" })).toBeVisible();
  await expect(page.locator(".shop-util").getByRole("link", { name: "회원가입" })).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-040-prepare-1440.png" });
  for (const [path, title] of [["/terms", /이용약관/], ["/privacy", /개인정보처리방침/], ["/help", "공지 · 이용안내"]] as const) {
    await page.goto(`/shop/${SLUG}${path}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole("heading", { name: "곧 문을 열어요" })).toHaveCount(0);
  }
  for (const path of ["legal/terms", "legal/privacy", "notices", "faqs"]) {
    expect((await page.request.get(`/api/shop/${SLUG}/${path}`)).status()).toBe(200);
  }
});

test("로그인 화면은 계속 열려 있다", async ({ page }) => {
  await setOperatingState(SLUG, "PAUSED");
  await page.goto(`/shop/${SLUG}/login`);
  await expect(page.locator("form.shop-login")).toBeVisible();
  await page.goto(`/shop/${SLUG}/help`);
  await expect(page.getByRole("heading", { level: 1, name: "공지 · 이용안내" })).toBeVisible();
  expect((await page.request.get(`/api/shop/${SLUG}/legal/terms`)).status()).toBe(200);
});

test("일시 정지(로그인 후): 내 주문 보기, 결제 기다리는 주문이 있으면 결제 이어하기", async ({ page, baseURL }) => {
  await login(page, baseURL!);
  const before = (await (await page.request.get(`/api/shop/${SLUG}/orders?tab=pending&limit=1`)).json()) as { counts: { pending: number } };
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  const pid = list.products.find((p) => p.name === "탑로더 25장")!.id;
  const product = (await (await page.request.get(`/api/shop/${SLUG}/products/${pid}`)).json()) as { product: { options: { id: string }[] } };
  const consent = (await (await page.request.get(`/api/shop/${SLUG}/order-consent`)).json()) as { consents: { version: string }[] };
  const made = await page.request.post(`/api/shop/${SLUG}/orders`, {
    headers: { origin: baseURL! },
    data: {
      items: [{ optionId: product.product.options[0].id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: consent.consents[0].version },
      shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12" },
      saveAddress: false,
    },
  });
  expect(made.ok()).toBe(true);
  const { orderId } = (await made.json()) as { orderId: string };
  await setOperatingState(SLUG, "PAUSED");
  await page.goto(`/shop/${SLUG}/cart`);
  const card = page.locator(".shop-state");
  await expect(page.getByRole("heading", { name: "지금은 잠시 쉬고 있어요", level: 1 })).toBeVisible();
  await expect(card).toContainText("진행 중인 주문은 그대로 처리돼요.");
  await expect(card).toContainText("새 주문 · 장바구니 · 회원가입은 다시 열면 할 수 있어요");
  await expect(card.getByRole("link", { name: "내 주문 보기" })).toHaveAttribute("href", `/shop/${SLUG}/orders`);
  const n = before.counts.pending + 1;
  await expect(card).toContainText(`결제를 기다리는 주문이 ${n}건 있어요`);
  // 한 건이면 그 주문 상세로, 여러 건이면 주문 내역으로 이어진다
  await expect(card.getByRole("link", { name: "결제 이어하기" })).toHaveAttribute("href", n === 1 ? `/shop/${SLUG}/orders/${orderId}` : `/shop/${SLUG}/orders`);
  // 주문 내역·주문 상세는 열려 있다
  await page.goto(`/shop/${SLUG}/orders/${orderId}`);
  await expect(page.getByLabel("주문 요약")).toBeVisible();
});

test("휴대폰 390: 안내 화면 가로 스크롤 없음", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setOperatingState(SLUG, "PREPARING");
  await page.goto(`/shop/${SLUG}`);
  await expect(page.getByRole("heading", { name: "곧 문을 열어요", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "tests/e2e/screenshots/SH-040-prepare-390.png" });
});
