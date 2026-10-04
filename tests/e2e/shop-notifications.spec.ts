import { expect, test, type Page } from "@playwright/test";
import { ensureShopInDb } from "./shopDb";

// SH-025 알림 설정: 구매자가 마케팅 정보 수신을 철회·다시 동의하고, 처리 결과(보낸 곳·결과·처리 날짜)를 바로 본다.
// 운영 빌드 + 데모 시드(demo-buyer1@example.com, 비밀번호는 E2E_PASSWORD).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const SLUG = "demo-shop";
const PAGE = `/shop/${SLUG}/me/notifications`;
const API = `/api/shop/${SLUG}/me/marketing-consent`;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function buyerLogin(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

// 한국 날짜(화면과 같은 모양)
const today = () => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(new Date());

test("구매자: 마케팅 정보 수신을 철회하면 바로 처리 결과가 나오고, 동의 문구를 보고 다시 동의할 수 있다", async ({ page, baseURL }) => {
  await buyerLogin(page, baseURL!);
  // 시작 상태를 철회로 맞춘다
  expect((await page.request.put(API, { data: { agreed: false }, headers: { origin: baseURL! } })).status()).toBe(200);
  await page.goto(PAGE);
  await expect(page).toHaveTitle("알림 설정 · 카드숍 별빛");
  const sw = page.getByRole("switch", { name: "마케팅 정보 받기" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("새 상품 · 방송 시작 · 할인 소식을 받지 않아요")).toBeVisible();

  // 켜면 동의 문구를 먼저 보여 준다(바로 동의하지 않음)
  await sw.click();
  const terms = page.getByTestId("mc-terms");
  await expect(terms).toContainText("마케팅 정보 수신 동의 (선택)");
  // 동의 전에 서식 전체(이용 목적·항목·보유 기간)를 보여 준다
  const doc = terms.getByTestId("mc-doc");
  await expect(doc).toContainText("카드숍 별빛은(는) 라이브 방송 시작·이벤트·할인·새 상품 소식을 보내기 위해");
  await expect(doc.getByRole("cell", { name: "이름, 휴대폰 번호" })).toBeVisible();
  await expect(doc.getByRole("cell", { name: "동의를 철회하거나 회원 탈퇴할 때까지" })).toBeVisible();
  await expect(doc).toContainText("카카오톡 광고 메시지·문자");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await shot(page, "SH-025-terms");
  // 동의 문구가 바뀐 뒤(409 consent_outdated): 문구를 다시 보여 주고 지금 버전으로 다시 동의한다
  await page.route(
    (u) => u.pathname === API,
    (route) =>
      route.request().method() === "PUT"
        ? route.continue({ postData: JSON.stringify({ agreed: true, marketingVersion: "2000-01-01.v0" }) })
        : route.continue(),
    { times: 1 },
  );
  await terms.getByRole("button", { name: "동의하고 받기" }).click();
  await expect(page.getByText("동의 내용이 바뀌었어요. 다시 확인하고 동의해 주세요")).toBeVisible();
  await expect(terms).toBeVisible();
  const agreed = page.waitForResponse((r) => r.url().endsWith(API) && r.request().method() === "PUT");
  await terms.getByRole("button", { name: "동의하고 받기" }).click();
  const body = (await (await agreed).json()) as { agreed: boolean; version: string; currentVersion: string };
  expect(body.agreed).toBe(true);
  expect(body.version).toBe(body.currentVersion);
  await expect(page.getByTestId("mc-result")).toHaveText(`카드숍 별빛에서 보내는 마케팅 정보 수신에 동의했어요 · 처리일 ${today()}`);
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(terms).toHaveCount(0);

  // 끄면 바로 철회하고 결과(보낸 곳·처리 날짜)를 알린다
  await sw.click();
  await expect(page.getByTestId("mc-result")).toHaveText(`카드숍 별빛에서 보내는 마케팅 정보 수신을 철회했어요 · 처리일 ${today()}`);
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await shot(page, "SH-025-withdrawn");
  // 새로 열어도 철회된 상태다
  await page.reload();
  await expect(page.getByRole("switch", { name: "마케팅 정보 받기" })).toHaveAttribute("aria-checked", "false");
});

test("구매자: 동의 응답을 놓쳐도 지금 상태를 다시 읽어 처리 결과를 보여 준다", async ({ page, baseURL }) => {
  await buyerLogin(page, baseURL!);
  expect((await page.request.put(API, { data: { agreed: false }, headers: { origin: baseURL! } })).status()).toBe(200);
  await page.goto(PAGE);
  const sw = page.getByRole("switch", { name: "마케팅 정보 받기" });
  await sw.click();
  await page.route(
    (u) => u.pathname === API,
    async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await route.fetch();
      return route.abort("connectionreset");
    },
    { times: 1 },
  );
  await page.getByTestId("mc-terms").getByRole("button", { name: "동의하고 받기" }).click();
  await expect(page.getByTestId("mc-result")).toHaveText(`카드숍 별빛에서 보내는 마케팅 정보 수신에 동의했어요 · 처리일 ${today()}`);
  await expect(sw).toHaveAttribute("aria-checked", "true");
  // 끝: 철회로 돌려 둔다
  expect((await page.request.put(API, { data: { agreed: false }, headers: { origin: baseURL! } })).status()).toBe(200);
});

test("구매자: 로그인하지 않았거나 다른 쇼핑몰 세션이면 로그인이 필요하다고 안내한다", async ({ page, baseURL }) => {
  await page.goto(PAGE);
  await expect(page.getByRole("heading", { name: "로그인이 필요해요" })).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(0);

  // 이 쇼핑몰 세션으로 다른 쇼핑몰의 알림 설정을 열면 401
  await ensureShopInDb("e2e-other-shop", "다른 카드숍");
  await buyerLogin(page, baseURL!);
  expect((await page.request.get("/api/shop/e2e-other-shop/me/marketing-consent")).status()).toBe(401);
  await page.goto("/shop/e2e-other-shop/me/notifications");
  await expect(page.locator(".shop-name")).toHaveText("다른 카드숍");
  await expect(page.getByRole("heading", { name: "로그인이 필요해요" })).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(0);
  await shot(page, "SH-025-login");
});
