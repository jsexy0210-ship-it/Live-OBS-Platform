import { expect, test, type Page } from "@playwright/test";

// 구매자 쇼핑몰 공통 틀(카페24식, docs/DESIGN_PROMPT.md 「구매자 쇼핑몰(SH)」) — 운영 빌드(next start) + 데모 시드 기준.
// PC: 맨 위 띠(로그인·회원가입·주문 조회·고객센터) → 로고·검색·장바구니 → 카테고리 가로 메뉴, 상품 격자 4열.
// 태블릿 3열. 휴대폰: 로고·검색·장바구니 + 카테고리 서랍 + 아래 고정 바, 격자 2열. 어느 폭에서도 가로 스크롤 없음.
// 로그인 흐름은 데모 구매자(demo-buyer1@example.com, 비밀번호 E2E_PASSWORD)로 확인한다.
const SLUG = "demo-shop";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

const columns = (page: Page) => page.locator(".pc-grid").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `tests/e2e/screenshots/${name}.png`, fullPage: true });
}

test.describe("PC 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("머리·카테고리·상품 격자 4열·바닥글", async ({ page }) => {
    const res = await page.goto(`/shop/${SLUG}`);
    expect(res?.status()).toBe(200);
    const util = page.locator(".shop-util");
    for (const name of ["로그인", "회원가입", "주문 조회", "고객센터"]) await expect(util.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(page.locator(".shop-name")).toHaveText("카드숍 별빛");
    await expect(page.getByRole("search").getByLabel("상품 검색")).toBeVisible();
    await expect(page.getByRole("link", { name: "장바구니" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "카테고리" }).getByRole("link", { name: "전체 상품" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "바로 가기" })).toBeHidden();
    await expect(page.getByRole("button", { name: "카테고리 메뉴" })).toBeHidden();

    // 판매 중·품절만 보이고 숨김·임시 저장 상품은 보이지 않는다. 품절은 표시가 붙는다.
    const grid = page.getByRole("list", { name: "전체 상품" });
    await expect(grid.getByText("스타라이트 부스터 박스")).toBeVisible();
    await expect(grid.locator(".pc", { hasText: "드래곤 소울 부스터" }).locator(".pc-out")).toHaveText("SOLD OUT");
    await expect(grid.locator(".pc", { hasNotText: "드래곤 소울 부스터" }).locator(".pc-out")).toHaveCount(0);
    await expect(grid.getByText("문라이트 1탄 박스")).toHaveCount(0);
    await expect(grid.getByText("카드 슬리브 100매")).toHaveCount(0);
    await expect(grid.locator(".pc").first().getByText("189,000원")).toBeVisible();
    expect(await columns(page)).toBe(4);
    // 사진 칸은 1:1
    const box = await grid.locator(".pc-photo").first().boundingBox();
    expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(1);
    // 긴 이름은 2줄까지
    const nameBox = await grid.locator(".pc", { hasText: "포켓몬 카드 게임" }).locator(".pc-name").boundingBox();
    expect(nameBox!.height).toBeLessThanOrEqual(41);

    await expect(page.locator(".shop-foot")).toContainText("카드숍 별빛");
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, "SH-001-cafe24-1440");
  });

  test("검색·전체 상품 정렬", async ({ page }) => {
    await page.goto(`/shop/${SLUG}`);
    await page.getByRole("search").getByLabel("상품 검색").fill("박스");
    await page.getByRole("search").getByRole("button", { name: "검색" }).click();
    await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/search\\?q=`));
    const results = page.getByRole("list", { name: "‘박스’ 검색 결과" });
    await expect(results.getByText("스타라이트 부스터 박스")).toBeVisible();
    await expect(results.getByText("탑로더 25장")).toHaveCount(0);

    await page.goto(`/shop/${SLUG}/search?q=${encodeURIComponent("없는상품이름")}`);
    await expect(page.getByText("찾는 상품이 없어요. 다른 검색어로 찾아보세요.")).toBeVisible();

    await page.getByRole("navigation", { name: "카테고리" }).getByRole("link", { name: "전체 상품" }).click();
    await expect(page.getByRole("heading", { name: /전체 상품/ })).toBeVisible();
    await page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "낮은 가격" }).click();
    await expect(page).toHaveURL(/sort=low/);
    await expect(page.locator(".pc-grid .pc").first()).toContainText("탑로더 25장");
    await page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" }).click();
    await expect(page.locator(".pc-grid .pc").first()).toContainText("스타라이트 부스터 박스");
  });

  test("로그인하면 머리가 내 정보·로그아웃으로 바뀌고, 로그아웃하면 돌아온다", async ({ page }) => {
    test.skip(!PASSWORD, "E2E_PASSWORD가 없으면 데모 구매자로 로그인할 수 없다");
    await page.goto(`/shop/${SLUG}/me`);
    await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/login\\?next=`));
    await page.getByLabel("아이디(이메일)").fill("demo-buyer1@example.com");
    await page.getByLabel("비밀번호").fill("wrong-password");
    await page.locator("form.shop-login").getByRole("button", { name: "로그인" }).click();
    await expect(page.locator("form.shop-login [role=alert]")).toBeVisible();
    await page.getByLabel("비밀번호").fill(PASSWORD);
    await page.locator("form.shop-login").getByRole("button", { name: "로그인" }).click();
    await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/me$`));
    await expect(page.getByRole("heading", { name: "내 정보" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "내 정보 메뉴" }).getByRole("link", { name: "쿠폰함" })).toBeVisible();
    const util = page.locator(".shop-util");
    await expect(util.getByRole("link", { name: "내 정보" })).toBeVisible();
    await expect(util.getByRole("link", { name: "로그인", exact: true })).toHaveCount(0);
    await util.getByRole("button", { name: "로그아웃" }).click();
    await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}$`));
    await expect(util.getByRole("link", { name: "로그인", exact: true })).toBeVisible();
  });
});

test.describe("태블릿 900", () => {
  test.use({ viewport: { width: 900, height: 1000 } });

  test("상품 격자 3열, 가로 스크롤 없음", async ({ page }) => {
    await page.goto(`/shop/${SLUG}`);
    await expect(page.getByRole("navigation", { name: "카테고리" }).getByRole("link", { name: "전체 상품" })).toBeVisible();
    expect(await columns(page)).toBe(3);
    expect(await noSideScroll(page)).toBe(true);
  });
});

test.describe("휴대폰 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("머리는 로고·검색·장바구니만, 카테고리 서랍, 아래 고정 바, 격자 2열", async ({ page }) => {
    await page.goto(`/shop/${SLUG}`);
    await expect(page.locator(".shop-util")).toBeHidden();
    await expect(page.locator("nav.shop-cats")).toBeHidden();
    await expect(page.getByRole("search")).toBeHidden();
    await expect(page.locator(".shop-name")).toBeVisible();
    const top = page.locator(".shop-top");
    await expect(top.getByRole("link", { name: "검색" })).toBeVisible();
    await expect(top.getByRole("link", { name: "장바구니" })).toBeVisible();

    const bar = page.getByRole("navigation", { name: "바로 가기" });
    await expect(bar).toBeVisible();
    for (const name of ["홈", "검색", "장바구니", "내 정보"]) await expect(bar.getByRole("link", { name })).toBeVisible();
    await expect(bar.getByRole("link", { name: "홈" })).toHaveAttribute("aria-current", "page");
    const barBox = await bar.boundingBox();
    expect(Math.round(barBox!.y + barBox!.height)).toBe(844);

    expect(await columns(page)).toBe(2);
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, "SH-001-cafe24-390");

    // 메뉴 버튼 → 서랍(카테고리·로그인), Esc로 닫는다
    await page.getByRole("button", { name: "카테고리 메뉴" }).click();
    const drawer = page.getByRole("dialog", { name: "카테고리 메뉴" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "전체 상품" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "로그인" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "메뉴 닫기" })).toBeFocused();
    await shot(page, "SH-001-cafe24-390-drawer");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // 고정 바 「카테고리」도 같은 서랍을 연다. 서랍에서 고르면 그 화면으로 가고 서랍은 닫힌다.
    await bar.getByRole("button", { name: "카테고리" }).click();
    await drawer.getByRole("link", { name: "전체 상품" }).click();
    await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/products$`));
    await expect(drawer).toBeHidden();
    expect(await columns(page)).toBe(2);
    expect(await noSideScroll(page)).toBe(true);
  });

  test("기존 구매자 화면도 같은 틀(회원가입·준비 중 화면)", async ({ page }) => {
    for (const path of ["signup", "cart", "login"]) {
      await page.goto(`/shop/${SLUG}/${path}`);
      await expect(page.getByRole("navigation", { name: "바로 가기" })).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
    }
    await page.goto(`/shop/${SLUG}/cart`);
    await expect(page.getByRole("heading", { name: "장바구니는 준비 중이에요" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "바로 가기" }).getByRole("link", { name: "장바구니" })).toHaveAttribute("aria-current", "page");
  });
});
