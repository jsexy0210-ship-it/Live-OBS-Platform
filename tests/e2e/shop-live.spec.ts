import { expect, test, type Page } from "@playwright/test";
import { deleteBuyerOrdersSince, resetCartInDb } from "./cartDb";
import { endLiveInDb, startLiveInDb } from "./liveDb";

// IA ① LIVE 전면: 방송 중이면 맨 위 띠, 방송 상품 카드의 LIVE 배지, 상품 상세의 「이 상품이 지금 방송 중이에요」. 방송이 없으면 아무것도 없다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const since = new Date(Date.now() - 60_000);
let sessionId: string | null = null;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  if (sessionId) await endLiveInDb(sessionId);
  await deleteBuyerOrdersSince(SLUG, LOGIN, since);
  await resetCartInDb(SLUG, LOGIN, []);
});

async function makeOrder(page: Page, baseURL: string) {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  const p = list.products.find((x) => x.name === "탑로더 25장")!;
  const detail = (await (await page.request.get(`/api/shop/${SLUG}/products/${p.id}`)).json()) as { product: { options: { id: string }[] } };
  const consent = (await (await page.request.get(`/api/shop/${SLUG}/order-consent`)).json()) as { consents: { version: string }[] };
  const r = await page.request.post(`/api/shop/${SLUG}/orders`, {
    headers: { origin: baseURL },
    data: {
      items: [{ optionId: detail.product.options[0].id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: consent.consents[0].version },
      shippingAddress: { recipientName: "김별빛", phone: "01012345678", zipCode: "06234", address1: "서울 강남구 테스트로 12" },
      saveAddress: false,
    },
  });
  expect(r.ok()).toBe(true);
  return { productId: p.id, orderId: ((await r.json()) as { orderId: string }).orderId };
}

test("방송이 없으면 띠·배지가 없고, 방송 중이면 띠와 방송 상품 배지·상세 안내가 보인다", async ({ page, baseURL }) => {
  await page.goto(`/shop/${SLUG}`);
  await expect(page.getByText("지금 라이브 방송 중이에요")).toHaveCount(0);

  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  const { productId, orderId } = await makeOrder(page, baseURL!);
  sessionId = await startLiveInDb(SLUG, orderId);

  await page.goto(`/shop/${SLUG}/products`);
  const bar = page.locator(".live-bar");
  await expect(bar).toContainText("지금 라이브 방송 중이에요 · e2e 라이브 방송");
  await expect(bar.getByRole("link", { name: "방송 보기" })).toHaveCount(0); // 유튜브 연결이 없으면 숨김
  const card = page.locator("li.pc", { has: page.getByRole("link", { name: "탑로더 25장", exact: true }) });
  await expect(card.locator(".pc-live")).toHaveText("LIVE");
  await expect(page.locator(".pc-live")).toHaveCount(1); // 방송에서 주문된 상품만

  await page.goto(`/shop/${SLUG}/products/${productId}`);
  await expect(page.getByText("이 상품이 지금 방송 중이에요")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/SH-live-detail-1440.png" });

  await endLiveInDb(sessionId);
  sessionId = null;
  await page.goto(`/shop/${SLUG}/products/${productId}`);
  await expect(page.getByText("이 상품이 지금 방송 중이에요")).toHaveCount(0);
  await expect(page.locator(".live-bar")).toHaveCount(0);
});
