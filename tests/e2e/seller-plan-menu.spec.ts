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

const menu = (page: Page) => page.getByRole("complementary", { name: "파트너스 메뉴" });
// 스토어 운영(쇼핑몰 기능) 권한이 있어야 보이는 메뉴
const STORE_MENUS = ["통계", "상품", "적립금", "쿠폰", "회원", "쇼핑몰 설정", "배너 · 팝업", "결제(PG) 연결", "주문자 알림"];
// 오버레이 전용에서도 보이는 메뉴(오버레이 권한·기존 주문 처리·계정·구독)
const COMMON_MENUS = ["주문", "구매 제한", "방송 대시보드", "오버레이 편집기", "방송 이력", "구독 · 결제", "직원 계정", "내 계정"];

test("쇼핑몰 통합은 쇼핑몰 기능 메뉴가 모두 보인다", async ({ page }) => {
  await login(page, INTEGRATED, "/seller/orders");
  const me = await (await page.request.get("/api/seller/me")).json();
  expect(me.features).toContain("STORE_OPERATIONS");
  for (const label of [...STORE_MENUS, ...COMMON_MENUS]) await expect(menu(page).getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByTestId("plan-feature-required")).toHaveCount(0);
  await shot(page, "plan-menu-integrated");
});

test("오버레이 전용은 쇼핑몰 기능 메뉴를 숨기고, 오버레이·주문·계정 메뉴는 남긴다", async ({ page }) => {
  await login(page, OVERLAY, "/seller/orders");
  const me = await (await page.request.get("/api/seller/me")).json();
  expect(me.features).toEqual(["OVERLAY", "EXTERNAL_INTEGRATION"]);
  await expect(page.getByRole("heading", { name: "주문" })).toBeVisible();
  for (const label of COMMON_MENUS) await expect(menu(page).getByText(label, { exact: true })).toBeVisible();
  for (const label of STORE_MENUS) await expect(menu(page).getByText(label, { exact: true })).toHaveCount(0);
  await shot(page, "plan-menu-overlay");
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
  await expect(page.getByText("판매 › 상품")).toBeVisible();
  // 상품 화면 내용(등록 버튼)은 그리지 않는다
  await expect(page.getByText("상품 등록")).toHaveCount(0);
  await shot(page, "plan-feature-required");

  await guide.getByRole("link", { name: "주문 화면으로 이동" }).click();
  await expect(page).toHaveURL(/\/seller\/orders$/);
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
  await expect(menu(page).getByText("상품", { exact: true })).toHaveCount(0);
  await expect(menu(page).getByText("주문", { exact: true })).toBeVisible();
});
