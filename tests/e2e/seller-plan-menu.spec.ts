import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 요금제 기능 권한에 따른 파트너스 메뉴(ARCHITECTURE 4.8.0). dev-seed의 데모 쇼핑몰(통합, 체험 중)과
// 오버레이 전용 쇼핑몰(demo-overlay, 체험 중)로 메뉴 차이와 403 plan_feature_required 안내 화면을 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const INTEGRATED = "demo-owner@example.com";
const OVERLAY = "demo-overlay-owner@example.com";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function login(page: Page, email: string, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${next.replace(/\//g, "\\/")}$`));
}

const gnb = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });
const lnb = (page: Page) => page.getByRole("complementary", { name: "파트너스 메뉴" });
// 왼쪽 메뉴의 하위 메뉴(대분류 제목은 제외). 고르지 않은 대분류는 화면에서 접혀 있어 있는지(개수)로 확인한다
const lnbItem = (page: Page, label: string) => lnb(page).locator(".lnb-i").filter({ hasText: new RegExp(`^${label.replace(/[()]/g, "\\$&")}$`) });
// 스토어 운영(쇼핑몰 기능) 권한이 있어야 보이는 하위 메뉴
const STORE_MENUS = ["상품 목록", "재고", "쿠폰", "회원 목록", "홈 배너", "알림 설정"];
// 오버레이 전용에서도 보이는 하위 메뉴(오버레이 권한·기존 주문 처리·계정·구독)
const COMMON_MENUS = ["전체 주문", "구매 제한", "방송 대시보드", "방송 화면 꾸미기", "방송 기록", "구독 · 결제", "직원 계정"];
const overlayMe = (orderFollowup: boolean) => async (route: import("@playwright/test").Route) => {
  const res = await route.fetch();
  const body = await res.json();
  await route.fulfill({ response: res, json: { ...body, orderFollowup } });
};

test("쇼핑몰 통합은 쇼핑몰 기능 메뉴가 모두 보인다", async ({ page }) => {
  await login(page, INTEGRATED, "/seller/orders");
  const me = await (await page.request.get("/api/seller/me")).json();
  expect(me.features).toContain("STORE_OPERATIONS");
  for (const label of [...STORE_MENUS, ...COMMON_MENUS]) await expect(lnbItem(page, label)).toHaveCount(1);
  await expect(gnb(page).locator(".gnb-i")).toHaveText(["홈", "방송", "주문", "상품", "고객", "마케팅", "통계", "설정"]);
  await expect(gnb(page).getByRole("link", { name: "통계", exact: true })).toHaveAttribute("href", "/seller/stats");
  await expect(page.getByTestId("plan-feature-required")).toHaveCount(0);
  await shot(page, "plan-menu-integrated");
});

test("오버레이 전용은 쇼핑몰 기능 메뉴를 숨기고, 오버레이·후속 처리·계정 메뉴는 남긴다", async ({ page }) => {
  // 데모 오버레이 쇼핑몰에는 끝나지 않은 주문이 없어 후속 처리 여부(orderFollowup)를 켠 값으로 바꿔 읽는다(꺼진 경우는 아래 시험)
  await page.route("**/api/seller/me", overlayMe(true));
  await login(page, OVERLAY, "/seller/orders");
  const me = await (await page.request.get("/api/seller/me")).json();
  expect(me.features).toEqual(["OVERLAY", "EXTERNAL_INTEGRATION"]);
  await expect(page.getByRole("heading", { name: "주문" })).toBeVisible();
  for (const label of COMMON_MENUS) await expect(lnbItem(page, label)).toHaveCount(1);
  for (const label of STORE_MENUS) await expect(lnbItem(page, label)).toHaveCount(0);
  // 상품·프로모션·디자인 대분류는 하위 메뉴가 모두 숨어 GNB에서도 사라진다
  await expect(gnb(page).locator(".gnb-i")).toHaveText(["홈", "방송", "주문", "고객", "통계", "설정"]);
  // 통계는 방송 통계만 연다(매출·상품 등은 숨김)
  await expect(gnb(page).getByRole("link", { name: "통계", exact: true })).toHaveAttribute("href", "/seller/stats/broadcasts");
  await shot(page, "plan-menu-overlay");
});

test("로그인 뒤 기본 화면: 통합은 지금처럼 상품, 오버레이 전용은 안내 화면 대신 오버레이 홈", async ({ page }) => {
  await page.goto("/seller/login");
  await submitSellerLogin(page, INTEGRATED, PASSWORD);
  await expect(page).toHaveURL(/\/seller$/);
  await page.goto("/seller/products");
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.context().clearCookies();

  // 앞 화면의 뒤쪽 요청이 로그인으로 스스로 넘기는 중이면 이동이 끊긴다(ERR_ABORTED): 한 번 더 연다
  await page.goto("/seller/login").catch(async (e: Error) => {
    if (!e.message.includes("ERR_ABORTED")) throw e;
    await page.goto("/seller/login");
  });
  await submitSellerLogin(page, OVERLAY, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/home-overlay$/);
  await expect(page.getByTestId("plan-feature-required")).toHaveCount(0);
  await shot(page, "plan-overlay-landing");

  // 방송 통계는 열려 있고, 통계 탭도 방송만 남는다
  await page.goto("/seller/stats/broadcasts");
  await expect(page.getByRole("heading", { name: "통계 · 방송" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "통계 종류" }).getByRole("link")).toHaveText(["방송"]);

  // 매출·주문 통계 요약은 주소로 들어와도 안내 화면
  await page.goto("/seller/stats");
  await expect(page.getByTestId("plan-feature-required")).toBeVisible();
});

test("오버레이 전용이 쇼핑몰 기능 주소로 바로 들어오면 안내 화면을 보이고, 열 수 있는 화면으로 보낸다", async ({ page }) => {
  await login(page, OVERLAY, "/seller/orders");
  // 서버도 막는다(화면 숨김만으로 막지 않음)
  const api = await page.request.get("/api/seller/products");
  expect(api.status()).toBe(403);
  expect((await api.json()).error).toBe("plan_feature_required");

  await page.goto("/seller/products");
  const guide = page.getByTestId("plan-feature-required");
  await expect(guide.getByRole("heading", { name: "지금 요금제에서 사용할 수 없는 기능입니다" })).toBeVisible();
  await expect(guide.getByText("쇼핑몰 통합 요금제에서 사용할 수 있습니다")).toBeVisible();
  await expect(guide.getByText("요금제는 구독 · 결제에서 바꿀 수 있습니다")).toBeVisible();
  await expect(guide.getByRole("link", { name: "구독 · 결제" })).toHaveAttribute("href", "/seller/subscription");
  await expect(page.locator(".loc-bar")).toContainText("상품›상품 목록");
  // 상품 화면 내용(등록 버튼)은 그리지 않는다
  await expect(page.getByText("상품 등록")).toHaveCount(0);
  await shot(page, "plan-feature-required");

  // 열 수 있는 첫 메뉴(홈 = 오버레이 홈)로 보낸다
  await guide.getByRole("link", { name: "홈 화면으로 이동" }).click();
  await expect(page).toHaveURL(/\/seller\/home-overlay$/);
  await expect(page.getByTestId("plan-feature-required")).toHaveCount(0);
});

test("메뉴 정보가 지난 값이어도 서버가 403 plan_feature_required를 주면 안내 화면으로 바꾸고 메뉴를 다시 읽는다", async ({ page }) => {
  await login(page, OVERLAY, "/seller/orders");
  // 그사이 요금제가 바뀐 상황: 처음 읽은 /me만 쇼핑몰 기능이 있는 것처럼 바꾼다. 상품 API는 실제 서버가 403으로 막는다
  await page.route(
    "**/api/seller/me",
    async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, features: ["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"] } });
    },
    { times: 1 },
  );
  const blocked = page.waitForResponse((r) => r.url().includes("/api/seller/products") && r.status() === 403);
  await page.goto("/seller/products");
  await blocked;
  await expect(page.getByTestId("plan-feature-required")).toBeVisible();
  // 다시 읽은 /me(실제 값)로 메뉴에서 쇼핑몰 기능이 빠진다
  await expect(gnb(page).getByRole("link", { name: "상품", exact: true })).toHaveCount(0);
  await expect(gnb(page).getByRole("link", { name: "방송", exact: true })).toBeVisible();
});

const STORE_ME = ["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"];

test("403으로 막힌 뒤 다시 읽은 /me가 그 화면을 허용하면(그사이 요금제를 올림) 안내 화면을 지운다", async ({ page }) => {
  await login(page, OVERLAY, "/seller/orders");
  // 요금제를 올린 상황: /me는 계속 쇼핑몰 기능을 준다. 상품 API는 처음 한 번만 실제 서버(403), 그 뒤는 올린 뒤 응답(빈 목록)
  await page.route("**/api/seller/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), features: STORE_ME } });
  });
  let first = true;
  await page.route("**/api/seller/products*", async (route) => {
    if (first) {
      first = false;
      return route.continue();
    }
    await route.fulfill({ json: { products: [], nextCursor: null } });
  });
  const blocked = page.waitForResponse((r) => r.url().includes("/api/seller/products") && r.status() === 403);
  await page.goto("/seller/products");
  await blocked;
  // 차단 뒤 다시 읽은 /me가 상품 화면을 허용하므로 안내 화면이 풀리고 상품 화면이 다시 그려진다
  await expect(page.getByTestId("plan-feature-required")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^상품/ })).toBeVisible();
});

test("화면을 옮긴 뒤 늦게 온 403 plan_feature_required는 지금 화면을 막지 않는다", async ({ page }) => {
  await login(page, OVERLAY, "/seller/orders");
  // 처음 /me는 쇼핑몰 기능이 있는 것처럼(메뉴에 상품이 보이게), 상품 API 응답(실제 403)은 늦게 온다
  await page.route(
    "**/api/seller/me",
    async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), features: STORE_ME } });
    },
    { times: 1 },
  );
  await page.route("**/api/seller/products*", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const late = page.waitForResponse((r) => r.url().includes("/api/seller/products") && r.status() === 403);
  await page.goto("/seller/products");
  // 상품 응답을 기다리지 않고 주문 화면으로 옮긴다
  await gnb(page).getByRole("link", { name: "주문", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/orders$/);
  await late;
  await page.waitForTimeout(300);
  await expect(page.getByTestId("plan-feature-required")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "주문", exact: true })).toBeVisible();
});

test("같은 화면으로 돌아온 뒤 첫 방문에서 보낸 요청의 늦은 403이 와도 지금 방문을 막지 않는다", async ({ page }) => {
  await login(page, OVERLAY, "/seller/orders");
  // 메뉴·화면 판정은 쇼핑몰 기능이 있는 것처럼(/me), 상품 API는 첫 요청만 늦게 실제 서버(403), 다시 방문한 요청은 바로 빈 목록
  await page.route("**/api/seller/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), features: STORE_ME } });
  });
  let first = true;
  await page.route("**/api/seller/products*", async (route) => {
    if (!first) return route.fulfill({ json: { products: [], nextCursor: null } });
    first = false;
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  const late = page.waitForResponse((r) => r.url().includes("/api/seller/products") && r.status() === 403);
  await page.goto("/seller/products");
  // 상품 → 주문 → 다시 상품(첫 방문의 상품 요청은 아직 응답 전)
  await gnb(page).getByRole("link", { name: "주문", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/orders$/);
  await gnb(page).getByRole("link", { name: "상품", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await expect(page.getByRole("heading", { name: /^상품/ })).toBeVisible();
  // 안내 화면이 잠깐이라도 나타나는지 기록한다(다시 읽은 /me가 허용해 곧 지워지는 경우도 잡게)
  await page.evaluate(() => {
    const w = window as unknown as { __planShown: boolean };
    w.__planShown = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="plan-feature-required"]')) w.__planShown = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await late;
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __planShown: boolean }).__planShown)).toBe(false);
  await expect(page.getByTestId("plan-feature-required")).toHaveCount(0);
});

// #230: 오버레이 전용으로 내린 뒤에도 후속 처리할 일이 남았으면(orderFollowup) 주문·구매 제한·문의 메뉴가 보이고, 다 끝나면 숨는다
test("오버레이 전용: 후속 처리 대상이 남아 있으면 주문·회원 대분류가 보이고, 다 끝나면 GNB에서 숨는다", async ({ page }) => {
  await page.route("**/api/seller/me", overlayMe(true));
  await login(page, OVERLAY, "/seller/orders");
  await expect(gnb(page).locator(".gnb-i")).toHaveText(["홈", "방송", "주문", "고객", "통계", "설정"]);
  await expect(lnbItem(page, "전체 주문")).toHaveCount(1);
  await expect(lnbItem(page, "구매 제한")).toHaveCount(1);
  // 통합 화면은 보이는 탭이 하나라도 있으면 메뉴가 남는다: 문의 · 리뷰(문의 탭), 적립금(지급·회수 원장 탭)
  await expect(lnbItem(page, "문의 · 리뷰")).toHaveCount(1);
  await expect(lnbItem(page, "적립금")).toHaveCount(1);

  await page.unroute("**/api/seller/me");
  await page.route("**/api/seller/me", overlayMe(false));
  await page.goto("/seller/broadcast");
  await expect(gnb(page).locator(".gnb-i")).toHaveText(["홈", "방송", "통계", "설정"]);
  await expect(lnbItem(page, "전체 주문")).toHaveCount(0);
  await expect(lnbItem(page, "구매 제한")).toHaveCount(0);
});
