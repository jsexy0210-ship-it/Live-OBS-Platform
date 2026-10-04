import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-060 공유 미리보기: 대표자가 제목·설명을 정하면 쇼핑몰 공개 페이지의 og:title·og:description에 쓰이고,
// og:image는 서버가 그린 기본 카드(/api/shop/{slug}/og.png), 파비콘은 ONQ 기본(/branding/onq-32.png)이다. 운영 빌드(데모 시드)로 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

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

async function loginSeller(page: Page, email: string, password: string, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, password);
}

// Next 16은 일반 브라우저에 메타데이터를 스트리밍해서, 늦게 준비되면 <head> 대신 <body> 뒤쪽에 넣는다(크롤러에는 head에 넣음): 문서 전체에서 찾는다
const meta = (page: Page, key: string) => page.locator(`meta[property="${key}"], meta[name="${key}"]`).first();

test("대표자: 공유 미리보기 제목·설명을 저장하면 쇼핑몰 페이지의 공유 정보에 쓰이고, 비우면 쇼핑몰 이름으로 돌아간다", async ({ page }) => {
  await loginSeller(page, "demo-owner@example.com", PASSWORD, "/seller/settings/share");
  await expect(page).toHaveURL(/\/seller\/settings\/share$/);
  await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "공유 설정" })).toHaveAttribute("aria-current", "page");
  // 비어 있으면 미리보기 제목은 쇼핑몰 이름이다
  const card = page.getByTestId("sp-card");
  await expect(card).toContainText("카드숍 별빛");
  await expect(card.locator("img")).toHaveAttribute("src", "/api/shop/demo-shop/og.png");
  await expect.poll(() => card.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);

  const title = "별빛 카드숍 라이브";
  const description = "매주 금요일 밤 라이브로 만나요";
  await page.getByLabel("제목").fill(title);
  await page.getByLabel("설명").fill(description);
  await expect(card).toContainText(title);
  await expect(card).toContainText(description);
  await expect(page.getByText(`${Array.from(title).length}/60`)).toBeVisible();
  await shot(page, "SA-060-share");
  // 휴대폰 폭에서도 화면이 가로로 넘치지 않는다
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/seller/share-preview") && r.request().method() === "PUT");
  await page.getByRole("complementary").getByRole("button", { name: "저장" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText("공유 미리보기를 저장했습니다")).toBeVisible();

  // 쇼핑몰 공개 페이지: 저장한 제목·설명, 서버가 그린 카드 이미지, ONQ 기본 파비콘
  await page.goto("/shop/demo-shop/signup");
  await expect(meta(page, "og:title")).toHaveAttribute("content", title);
  await expect(meta(page, "og:description")).toHaveAttribute("content", description);
  await expect(meta(page, "og:image")).toHaveAttribute("content", /^https?:\/\/[^/]+\/api\/shop\/demo-shop\/og\.png\?v=[0-9a-f]{12}$/);
  await expect(meta(page, "og:image:width")).toHaveAttribute("content", "1200");
  await expect(meta(page, "twitter:card")).toHaveAttribute("content", "summary_large_image");
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /\/branding\/onq-32\.png/);
  // 화면 제목은 그 화면 것이 우선한다
  await expect(page).toHaveTitle("회원가입 · 카드숍 별빛");

  // 비우고 저장하면 기본값(제목은 쇼핑몰 이름, 설명 없음)으로 돌아간다
  await page.goto("/seller/settings/share");
  await page.getByLabel("제목").fill("");
  await page.getByLabel("설명").fill("");
  await expect(card).toContainText("카드숍 별빛");
  await page.getByRole("complementary").getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("공유 미리보기를 저장했습니다")).toBeVisible();
  await page.goto("/shop/demo-shop/signup");
  await expect(meta(page, "og:title")).toHaveAttribute("content", "카드숍 별빛");
  await expect(page.locator('meta[property="og:description"]')).toHaveCount(0);
});

test("공유 미리보기: 길이를 넘으면 저장할 수 없고, 쇼핑몰 설정 권한이 없는 직원은 볼 수 없다", async ({ page }) => {
  await loginSeller(page, "demo-owner@example.com", PASSWORD, "/seller/settings/share");
  await page.getByLabel("제목").fill("가".repeat(61));
  await expect(page.getByText("61/60")).toBeVisible();
  await expect(page.getByLabel("제목")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("complementary").getByRole("button", { name: "저장" })).toBeDisabled();
  // 글자 수는 서버와 같은 기준(NFKC 뒤)으로 센다: 합자 ﬃ 하나는 ffi 세 글자
  await page.getByLabel("제목").fill("ﬃ".repeat(30));
  await expect(page.getByText("90/60")).toBeVisible();
  await expect(page.getByText("60자까지 입력할 수 있습니다")).toBeVisible();
  await expect(page.getByRole("complementary").getByRole("button", { name: "저장" })).toBeDisabled();
  // 서버가 받지 않는 글자(줄바꿈)도 저장 전에 알린다
  await page.getByLabel("제목").fill("");
  await page.getByLabel("설명").fill("첫 줄\n둘째 줄");
  await expect(page.getByText("줄바꿈 없이 입력해 주십시오")).toBeVisible();
  await expect(page.getByLabel("설명")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("complementary").getByRole("button", { name: "저장" })).toBeDisabled();
  await page.context().clearCookies();

  // 상품 권한만 있는 직원: 화면은 권한 안내, API는 403
  await loginSeller(page, "demo-staff@example.com", PASSWORD, "/seller/settings/share");
  await expect(page).toHaveURL(/\/seller\/settings\/share$/);
  await expect(page.getByText("필요한 권한: 쇼핑몰 설정")).toBeVisible();
  await expect(page.getByLabel("제목")).toHaveCount(0);
  const put = await page.evaluate(async () => {
    const r = await fetch("/api/seller/share-preview", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "바꿈", description: null }) });
    return r.status;
  });
  expect(put).toBe(403);
});

test("공유 이미지 주소는 신뢰 프록시가 없으면 요청자가 보낸 X-Forwarded-Host를 따르지 않는다", async ({ page, baseURL }) => {
  await page.setExtraHTTPHeaders({ "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" });
  await page.goto("/shop/demo-shop/signup");
  await expect(meta(page, "og:image")).toHaveAttribute("content", new RegExp(`^${baseURL}/api/shop/demo-shop/og\\.png\\?v=`));
});

test("없는 쇼핑몰 주소는 공유 정보를 만들지 않고 기본값을 쓴다", async ({ page }) => {
  await page.goto("/shop/no-such-shop-zz/signup");
  // 메타데이터가 다 들어온 뒤(아이콘이 보인 뒤)에 og:image가 없는지 본다
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /\/branding\/onq-32\.png/);
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
});

// 저장 응답이 늦는 동안 칸을 고치면, 늦게 온 응답(보낸 값)이 새로 고친 값을 덮는다: 저장하는 동안은 칸을 잠근다
test("공유 미리보기: 저장하는 동안에는 칸을 잠가 저장 중 수정이 응답으로 덮이지 않는다", async ({ page }) => {
  await loginSeller(page, "demo-owner@example.com", PASSWORD, "/seller/settings/share");
  await expect(page).toHaveURL(/\/seller\/settings\/share$/);
  await page.getByLabel("제목").fill("잠금 확인 제목");
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/seller/share-preview", async (route) => {
    if (route.request().method() === "PUT") await held;
    await route.continue();
  });
  await page.getByRole("complementary").getByRole("button", { name: "저장" }).click();
  await expect(page.getByLabel("제목")).toBeDisabled();
  await expect(page.getByLabel("설명")).toBeDisabled();
  release();
  await expect(page.getByText("공유 미리보기를 저장했습니다")).toBeVisible();
  await expect(page.getByLabel("제목")).toBeEnabled();
  await expect(page.getByLabel("제목")).toHaveValue("잠금 확인 제목");
  await page.unrouteAll();
  // 끝: 기본값으로 되돌린다
  await page.getByLabel("제목").fill("");
  await page.getByRole("complementary").getByRole("button", { name: "저장" }).click();
  await expect(page.getByLabel("제목")).toHaveValue("");
});

// 설정 화면 안에 탭 줄이 없고, 왼쪽 메뉴로 각 설정 화면에 갈 수 있다
test("쇼핑몰 설정 화면에는 탭 줄이 없고, 왼쪽 메뉴로 각 설정 화면에 이동한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginSeller(page, "demo-owner@example.com", PASSWORD, "/seller/settings/share");
  await expect(page).toHaveURL(/\/seller\/settings\/share$/);
  await expect(page.getByRole("navigation", { name: "쇼핑몰 설정" })).toHaveCount(0);
  await expect(page.locator(".settings-tabs")).toHaveCount(0);
  const lnb = page.getByRole("complementary", { name: "파트너스 메뉴" });
  await expect(lnb.getByRole("link", { name: "공유 설정" })).toHaveAttribute("aria-current", "page");
  for (const [name, path] of [["쇼핑몰 정보", "shop"], ["주문 설정", "order"], ["배송 설정", "shipping"], ["회원 정책", "member"], ["공유 설정", "share"]] as const) {
    await lnb.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/seller/settings/${path}$`));
    await expect(page.getByRole("navigation", { name: "쇼핑몰 설정" })).toHaveCount(0);
  }
});

// 1440px(넓은 화면)에서도 공유 미리보기 스타일이 적용된다(좁은 화면 전용 블록 안에 갇히지 않음)
test("1440px에서 공유 미리보기 카드·입력 묶음 스타일이 적용된다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginSeller(page, "demo-owner@example.com", PASSWORD, "/seller/settings/share");
  await expect(page).toHaveURL(/\/seller\/settings\/share$/);
  await expect(page.getByTestId("sp-card")).toBeVisible();
  const styles = await page.evaluate(() => {
    const get = (sel: string) => getComputedStyle(document.querySelector(sel)!);
    return {
      cardMaxWidth: get(".sp-card").maxWidth,
      fieldsBorder: get(".settings-fields").borderTopWidth,
    };
  });
  expect(styles).toEqual({ cardMaxWidth: "420px", fieldsBorder: "0px" });
});
