import { expect, test, type Page } from "@playwright/test";
import { MARKETING_DOC_VERSION } from "../../components/shop/MarketingConsentDoc";
import { ensureShopInDb } from "./shopDb";
import { okConfirm } from "./shopConfirm";

// SH-025 알림 설정(알림 종류 × 알림톡·문자/이메일 표): 필수 알림 고정, 배송 채널별, 혜택·이벤트 = 마케팅 수신 동의(서식 확인 후 동의·철회, 처리 결과 바로 안내).
// 운영 빌드 + 데모 시드(demo-buyer1@example.com, 비밀번호는 E2E_PASSWORD).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const SLUG = "demo-shop";
const PAGE = `/shop/${SLUG}/me/notifications`;
const API = `/api/shop/${SLUG}/me/marketing-consent`;
const PREFS = `/api/shop/${SLUG}/me/notification-prefs`;

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
const box = (page: Page, title: string) => page.getByRole("checkbox", { name: title, exact: true });

test("구매자: 표 구조 · 필수 알림은 끌 수 없고, 혜택·이벤트를 켜면 서식을 먼저 보여 준 뒤 동의하고 결과(보낸 곳·처리 날짜)를 알린다", async ({ page, baseURL }) => {
  await buyerLogin(page, baseURL!);
  // 시작 상태를 철회로 맞춘다
  expect((await page.request.put(API, { data: { agreed: false }, headers: { origin: baseURL! } })).status()).toBe(200);
  await page.goto(PAGE);
  await expect(page).toHaveTitle("알림 설정 · 카드숍 별빛");
  const tbl = page.locator(".np-tbl");
  await expect(tbl.locator("tbody tr")).toHaveCount(6);
  await expect(tbl.locator("thead th")).toHaveText(["알림", "알림톡 · 문자", "이메일"]);
  // 주문·결제 · 내 차례는 두 칸 모두 켜져 있고 끌 수 없다
  for (const t of ["주문 · 결제 알림톡·문자", "주문 · 결제 이메일", "내 차례 알림 알림톡·문자", "내 차례 알림 이메일"]) {
    await expect(box(page, t)).toBeChecked();
    await expect(box(page, t)).toBeDisabled();
  }
  // 광고성 줄은 알림톡·문자 칸이 없고 메일만 보낸다
  await expect(tbl.locator("tr", { hasText: "방송 시작" })).toContainText("— (메일만)");
  await expect(box(page, "혜택 · 이벤트 (선택) 이메일")).not.toBeChecked();
  // 혜택·이벤트를 끄면 방송 시작·할인 메일도 받을 수 없다
  await expect(box(page, "방송 시작 이메일")).toBeDisabled();
  await expect(box(page, "할인 · 재입고 이메일")).toBeDisabled();
  await shot(page, "SH-025-prefs");

  // 켜면 동의 서식을 먼저 보여 준다(바로 동의하지 않음)
  await box(page, "혜택 · 이벤트 (선택) 이메일").click();
  const terms = page.getByTestId("mc-terms");
  await expect(terms).toContainText("혜택 · 이벤트 알림 받기 (선택)");
  const doc = terms.getByTestId("mc-doc");
  await expect(doc).toContainText("카드숍 별빛은(는) 라이브 방송 시작·이벤트·할인·새 상품 소식을 보내기 위해");
  await expect(doc.getByRole("cell", { name: "이름, 휴대폰 번호" })).toBeVisible();
  await expect(doc.getByRole("cell", { name: "동의를 철회하거나 회원 탈퇴할 때까지" })).toBeVisible();
  await expect(doc).toContainText("카카오톡 광고 메시지·문자");
  await expect(box(page, "혜택 · 이벤트 (선택) 이메일")).not.toBeChecked();
  await shot(page, "SH-025-terms");
  // 동의 문구가 바뀐 뒤(409 consent_outdated): 이 화면의 글은 예전 서식이라 다시 동의를 받지 않고 새로고침하게 한다
  await page.route(
    (u) => u.pathname === PREFS,
    (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      return route.continue({ postData: JSON.stringify({ ...body, marketingVersion: "2000-01-01.v0" }) });
    },
    { times: 1 },
  );
  await terms.getByRole("button", { name: "동의하고 받기" }).click();
  const reload = page.getByTestId("mc-reload");
  await expect(reload).toContainText("새로고침이 필요해요.");
  await expect(page.getByRole("button", { name: "동의하고 받기" })).toHaveCount(0);
  await shot(page, "SH-025-reload");
  await reload.getByRole("button", { name: "새로고침" }).click();
  await expect(reload).toHaveCount(0);
  // 새로고침한 뒤에는 서식 전체를 다시 보고, 그 서식에 묶인 버전으로 동의한다
  await box(page, "혜택 · 이벤트 (선택) 이메일").click();
  await expect(terms.getByTestId("mc-doc")).toBeVisible();
  const agreed = page.waitForResponse((r) => r.url().endsWith(PREFS) && r.request().method() === "PUT");
  await terms.getByRole("button", { name: "동의하고 받기" }).click();
  const res = await agreed;
  expect(res.request().postDataJSON()).toEqual({ prefs: { BENEFIT: { email: true } }, marketingVersion: MARKETING_DOC_VERSION });
  const state = (await res.json()) as { marketing: { agreed: boolean; version: string; currentVersion: string } };
  expect(state.marketing.agreed).toBe(true);
  expect(state.marketing.version).toBe(state.marketing.currentVersion);
  await expect(page.getByTestId("mc-result")).toHaveText(`카드숍 별빛에서 보내는 혜택·이벤트 알림 받기에 동의했어요 · 동의한 날 ${today()}`);
  await expect(box(page, "혜택 · 이벤트 (선택) 이메일")).toBeChecked();
  await expect(box(page, "방송 시작 이메일")).toBeEnabled();
  await expect(terms).toHaveCount(0);

  // 끄면 확인 창을 거쳐 철회하고 결과(보낸 곳·처리 날짜)를 알린다
  await box(page, "혜택 · 이벤트 (선택) 이메일").uncheck();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await okConfirm(page, "그만 받기");
  await expect(page.getByTestId("mc-result")).toHaveText(`카드숍 별빛에서 보내는 혜택·이벤트 알림을 껐어요 · 처리한 날 ${today()} · 다시 켜면 언제든 받을 수 있어요`);
  await expect(box(page, "혜택 · 이벤트 (선택) 이메일")).not.toBeChecked();
  await shot(page, "SH-025-withdrawn");
  // 새로 열어도 철회된 상태다
  await page.reload();
  await expect(box(page, "혜택 · 이벤트 (선택) 이메일")).not.toBeChecked();
});

test("구매자: 배송 알림은 채널별로 끄고 켤 수 있고 저장하면 새로 열어도 유지된다", async ({ page, baseURL }) => {
  await buyerLogin(page, baseURL!);
  await page.goto(PAGE);
  await box(page, "배송 알림톡·문자").uncheck();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByTestId("mc-result")).toHaveText("알림 설정을 저장했어요");
  await page.reload();
  await expect(box(page, "배송 알림톡·문자")).not.toBeChecked();
  await expect(box(page, "배송 이메일")).toBeChecked();
  // 끝: 되돌려 둔다
  await box(page, "배송 알림톡·문자").check();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByTestId("mc-result")).toHaveText("알림 설정을 저장했어요");
});

test("구매자: 동의 응답을 놓쳐도 지금 상태를 다시 읽어 처리 결과를 보여 준다", async ({ page, baseURL }) => {
  await buyerLogin(page, baseURL!);
  expect((await page.request.put(API, { data: { agreed: false }, headers: { origin: baseURL! } })).status()).toBe(200);
  await page.goto(PAGE);
  await box(page, "혜택 · 이벤트 (선택) 이메일").click();
  await page.route(
    (u) => u.pathname === PREFS,
    async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await route.fetch();
      return route.abort("connectionreset");
    },
    { times: 1 },
  );
  await page.getByTestId("mc-terms").getByRole("button", { name: "동의하고 받기" }).click();
  await expect(page.getByTestId("mc-result")).toHaveText(`카드숍 별빛에서 보내는 혜택·이벤트 알림 받기에 동의했어요 · 동의한 날 ${today()}`);
  await expect(box(page, "혜택 · 이벤트 (선택) 이메일")).toBeChecked();
  // 끝: 철회로 돌려 둔다
  expect((await page.request.put(API, { data: { agreed: false }, headers: { origin: baseURL! } })).status()).toBe(200);
});

// 화면을 연 뒤 서버의 서식 버전이 바뀌었다(이 화면의 글과 다름): 서버 버전으로 동의를 보내지 않고 새로고침을 안내한다
test("구매자: 서버의 동의 서식이 화면의 글과 다르면 동의를 받지 않고 새로고침을 안내한다", async ({ page, baseURL }) => {
  await buyerLogin(page, baseURL!);
  expect((await page.request.put(API, { data: { agreed: false }, headers: { origin: baseURL! } })).status()).toBe(200);
  await page.route(
    (u) => u.pathname === PREFS,
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const j = (await res.json()) as { marketing: Record<string, unknown> };
      return route.fulfill({ response: res, json: { ...j, marketing: { ...j.marketing, currentVersion: "2099-01-01.v9" } } });
    },
  );
  let puts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith(PREFS) && r.method() === "PUT") puts += 1;
  });
  await page.goto(PAGE);
  await box(page, "혜택 · 이벤트 (선택) 이메일").click();
  await expect(page.getByTestId("mc-reload")).toContainText("새로고침이 필요해요.");
  await expect(page.getByTestId("mc-doc")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "동의하고 받기" })).toHaveCount(0);
  expect(puts).toBe(0);
});

test("구매자: 로그인하지 않았거나 다른 쇼핑몰 세션이면 로그인이 필요하다고 안내한다", async ({ page, baseURL }) => {
  await page.goto(PAGE);
  await expect(page.getByRole("heading", { name: "로그인이 필요해요" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  // 이 쇼핑몰 세션으로 다른 쇼핑몰의 알림 설정을 열면 401
  await ensureShopInDb("e2e-other-shop", "다른 카드숍");
  await buyerLogin(page, baseURL!);
  expect((await page.request.get("/api/shop/e2e-other-shop/me/notification-prefs")).status()).toBe(401);
  await page.goto("/shop/e2e-other-shop/me/notifications");
  await expect(page.locator(".shop-name")).toHaveText("다른 카드숍");
  await expect(page.getByRole("heading", { name: "로그인이 필요해요" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await shot(page, "SH-025-login");
});
