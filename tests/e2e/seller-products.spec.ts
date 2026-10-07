import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { RUN, cleanupProducts, track } from "./cleanup";

// 판매자 로그인 → 상품 목록 → 등록 → 수정 → 숨김·삭제를 실제로 눌러 확인한다.
// E2E_SCREENSHOTS=1이면 390·1024·1440 화면을 tests/e2e/screenshots에 남긴다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const OWNER = "demo-owner@example.com";
const VIEWER = "demo-viewer@example.com";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
// 실행마다 다른 표식. 만든 상품은 track()으로 남겨 테스트가 끝나면 지운다
const stamp = RUN;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(() => cleanupProducts(PASSWORD));

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

// 테스트에서 만든 상품은 첫 쪽 목록에 기대지 않고 이름 검색(서버 q)으로 찾는다
// 검색 상자(표형)에 검색어를 넣고 「검색」을 누른다
const searchBox = (page: Page) => page.getByRole("search", { name: "목록 조건" });
async function searchFor(page: Page, text: string) {
  await page.getByLabel("상품 검색").fill(text);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/seller/products?") && new URL(r.url()).searchParams.get("q") === text.trim()),
    searchBox(page).getByRole("button", { name: "검색", exact: true }).click(),
  ]);
}
// 판매 상태·재고 라디오를 고르고 「검색」을 누른다(응답을 기다리지 않는다)
async function applyStatus(page: Page, status: string, stock = "전체") {
  const box = searchBox(page);
  await box.getByRole("radiogroup", { name: "판매 상태", exact: true }).getByRole("radio", { name: status, exact: true }).check();
  await box.getByRole("radiogroup", { name: "재고", exact: true }).getByRole("radio", { name: stock, exact: true }).check();
  await box.getByRole("button", { name: "검색", exact: true }).click();
}

async function login(page: Page, email = OWNER) {
  await page.goto("/seller/login");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller$/);
  await page.goto("/seller/products");
  await expect(page).toHaveURL(/\/seller\/products$/);
}

test("로그인 안 한 채로 상품 화면에 오면 로그인으로 보낸다", async ({ page }) => {
  await page.goto("/seller/products");
  await expect(page).toHaveURL(/\/seller\/login\?next=%2Fseller%2Fproducts/);
  await shot(page, "AU-002-login");
});

test("비밀번호가 틀리면 안내하고 로그인하지 않는다", async ({ page }) => {
  await page.goto("/seller/login");
  await page.getByLabel("이메일").fill(OWNER);
  await page.getByLabel("비밀번호").fill("wrong-password-x");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("이메일이나 비밀번호가 맞지 않습니다")).toBeVisible();
  await expect(page).toHaveURL(/\/seller\/login/);
  await shot(page, "AU-002-error");
});

test("상품 목록: 데모 상품·상태 배지·필터, 체험 배너가 보인다", async ({ page }) => {
  await login(page);
  await expect(page.getByText(/체험이 \d+일 남았습니다/)).toBeVisible();
  await expect(page.locator(".gnb")).toContainText("카드숍 별빛");
  const rows = page.getByTestId("product-row");
  await expect(rows.filter({ hasText: "스타라이트 부스터 박스" })).toBeVisible();
  await expect(rows.filter({ hasText: "탑로더 25장" }).getByText("재고 부족")).toBeVisible();
  await expect(rows.filter({ hasText: "드래곤 소울 부스터" }).getByText("품절")).toBeVisible();
  // 목록 행 높이와 상품명·가격 시작 위치는 상품명 길이(1줄 ~ 100자)와 관계없이 같고, 100자 이름은 3줄에서 말줄임된다
  const layout = await rows.evaluateAll((els) =>
    els.map((e) => {
      const top = e.getBoundingClientRect().top;
      const name = e.querySelector(".p-name")!;
      const price = e.querySelector("td.num")!;
      return {
        h: Math.round(e.getBoundingClientRect().height),
        name: Math.round(name.getBoundingClientRect().top - top),
        price: Math.round(price.getBoundingClientRect().top - top),
        nameH: Math.round(name.getBoundingClientRect().height),
        len: name.textContent!.length,
      };
    }),
  );
  expect(new Set(layout.map((l) => l.h)).size).toBe(1);
  expect(new Set(layout.map((l) => l.name)).size).toBe(1);
  expect(new Set(layout.map((l) => l.price)).size).toBe(1);
  // 상품명 칸은 짧은 이름도 100자 이름도 3줄(60px) 높이
  expect(new Set(layout.map((l) => l.nameH))).toEqual(new Set([60]));
  expect(layout.some((l) => l.len === 100)).toBe(true);
  expect(layout.some((l) => l.len <= 12)).toBe(true);
  await shot(page, "SA-011-list");

  await applyStatus(page, "숨김");
  await expect(rows.filter({ hasText: "문라이트 1탄 박스" })).toBeVisible();
  await expect(rows.filter({ hasText: "스타라이트 부스터 박스" })).toHaveCount(0);
});

test("상품 목록 제목 안내·검색 두 쌍·표 경계가 1440·1024·390에서 맞는다", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("product-row").first()).toBeVisible();
  const description = page.locator(".au-ph-description");
  await expect(description).toHaveText("상품을 검색하고 판매 상태와 재고를 관리합니다.");
  await expect(page.getByLabel("상품 검색")).toHaveAttribute("placeholder", "검색어 입력");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const layout = await page.evaluate(() => {
      const title = document.querySelector(".au-ph-title")!;
      const description = document.querySelector(".au-ph-description")!;
      const grid = document.querySelector('[aria-label="상품 목록 표"]')!;
      const head = document.querySelector(".au-lh")!;
      const style = getComputedStyle(title);
      return {
        font: style.fontSize, line: style.lineHeight,
        descriptionBelow: description.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
        descriptionFont: getComputedStyle(description).fontSize,
        descriptionLine: getComputedStyle(description).lineHeight,
        headOutside: !grid.contains(head),
        twoPairs: [...document.querySelectorAll(".au-ft tr")].filter(row => row.querySelectorAll("th").length === 2).length,
        gridVisible: getComputedStyle(grid).display !== "none",
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(layout).toMatchObject({ font: "20px", line: "28px", descriptionBelow: true, descriptionFont: "14px", descriptionLine: "20px", headOutside: true, twoPairs: 2, gridVisible: width >= 768, overflow: false });
    if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/SA-011-alignment-${width}.png`, fullPage: true });
  }

  // 상품 조회·인증은 실제 Next/격리 DB를 사용한다. 공통 배너 표시 상태만 주입하며,
  // 점검 예약·tenant LIVE 판정 API 자체는 admin-maintenance의 실제 DB 시험이 검증한다.
  await page.route("**/api/maintenance", route => route.fulfill({ json: {
    active: false, scheduled: true,
    startsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  } }));
  await page.route("**/api/seller/broadcast/summary", route => route.fulfill({ json: { broadcast: { status: "live" } } }));
  await page.evaluate(() => window.dispatchEvent(new Event("onq:maintenance-changed")));
  const banner = page.getByTestId("maintenance-seller-banner");
  await expect(banner).toContainText("방송을 끝내 주십시오");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(description).toBeVisible();
    const fit = await banner.evaluate(e => ({
      bottom: e.getBoundingClientRect().bottom,
      titleTop: document.querySelector(".au-ph-title")!.getBoundingClientRect().top,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    expect(fit.titleTop).toBeGreaterThanOrEqual(fit.bottom);
    expect(fit.overflow).toBe(false);
    if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/SA-011-maintenance-${width}.png`, fullPage: true });
  }
});

test("옵션 이름이 길어도 표는 내부에서 스크롤되고 페이지 폭을 밀지 않는다(1440·1024)", async ({ page }) => {
  await login(page);
  const row = page.getByTestId("product-row").filter({ hasText: "보관용 카드 바인더" });
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(row).toBeVisible();
    const fit = await page.locator(".p-table").evaluate((t) => {
      const wrap = t.closest(".p-tbl-wrap")!;
      return { table: t.scrollWidth, wrap: wrap.scrollWidth, page: document.documentElement.scrollWidth, client: document.documentElement.clientWidth };
    });
    expect(fit.table).toBeLessThanOrEqual(fit.wrap);
    expect(fit.page).toBeLessThanOrEqual(fit.client);
    // 판매가·재고·상태 열이 화면 안에 보인다(세로로는 그 줄까지 내려서 본다)
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByText("18,000원")).toBeInViewport();
    await expect(row.locator(".bdg")).toBeInViewport();
  }
});

test("상품 등록 → 목록에 바로 보인다", async ({ page }) => {
  const name = track(`e2e 부스터 팩 ${stamp}`);
  await login(page);
  await page.getByRole("link", { name: "상품 등록" }).first().click();
  await expect(page).toHaveURL(/\/seller\/products\/new$/);
  await shot(page, "SA-012-new-empty");

  // 빈 칸 검사: 판매가가 숫자가 아니면 막는다
  await page.getByLabel("상품명").fill(name);
  await expect(page.getByTestId("name-count")).toHaveText(`${name.length}/100`);
  await page.getByLabel("판매가").fill("만오천원");
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page.getByText("숫자만 입력해 주십시오")).toBeVisible();
  await expect(page.getByText(/아래 1개 항목을 확인해 주십시오: 판매가/)).toBeVisible();
  await shot(page, "SA-012-new-error");

  await page.getByLabel("판매가").fill("15,000");
  await page.getByLabel("옵션 1 이름").fill("1팩");
  await page.getByLabel("옵션 1 재고").fill("30");
  await page.getByRole("button", { name: "+ 옵션 추가" }).click();
  await page.getByLabel("옵션 2 이름").fill("3팩 묶음");
  await page.getByLabel("옵션 2 추가 금액").fill("28000");
  await page.getByLabel("옵션 2 재고").fill("5");
  await shot(page, "SA-012-new-filled");
  await page.getByRole("button", { name: "등록", exact: true }).first().click();

  await expect(page).toHaveURL(/\/seller\/products$/);
  await expect(page.getByText("상품을 등록했습니다")).toBeVisible();
  await searchFor(page, name);
  await expect(page.getByTestId("product-row")).toHaveCount(1);
  const row = page.getByTestId("product-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("15,000원");
  await expect(row).toContainText("35");
  await expect(row).toContainText("판매 중");
});

test("상품명 100자를 넘기면 글자 수가 빨갛게 바뀌고 안내한다(이모지도 1자, 서버와 같은 기준)", async ({ page }) => {
  await login(page);
  await page.goto("/seller/products/new");
  await page.getByLabel("상품명").fill("가".repeat(101));
  await expect(page.getByTestId("name-count")).toHaveText("101/100");
  await expect(page.getByText("상품명은 100자까지 입력할 수 있습니다")).toBeVisible();

  // 👍 101개는 101자로 세고 막는다
  await page.getByLabel("상품명").fill("👍".repeat(101));
  await expect(page.getByTestId("name-count")).toHaveText("101/100");
  await expect(page.getByText("상품명은 100자까지 입력할 수 있습니다")).toBeVisible();

  // 이모지 96개 + 실행마다 다른 글자 4개 = 100자라 서버도 받는다(실제로 등록해 목록에서 확인)
  const name100 = track("👍".repeat(96) + stamp.slice(-4));
  await page.getByLabel("상품명").fill(name100);
  await expect(page.getByTestId("name-count")).toHaveText("100/100");
  await expect(page.getByText("상품명은 100자까지 입력할 수 있습니다")).toHaveCount(0);
  await page.getByLabel("판매가").fill("1000");
  await page.getByRole("button", { name: "임시 저장" }).first().click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await expect(page.getByText("임시 저장했습니다")).toBeVisible();
  await applyStatus(page, "임시 저장");
  // 검색어는 50자까지라 이름 끝 20자(👍 16개 + 실행 표식 4자)로 찾는다
  await searchFor(page, [...name100].slice(-20).join(""));
  await expect(page.getByTestId("product-row").filter({ hasText: name100 })).toHaveCount(1);
});

test("상품 수정: 가격·재고를 바꾸면 저장되고 목록에도 반영된다", async ({ page }) => {
  await login(page);
  await page.getByTestId("product-row").filter({ hasText: "문라이트 컬렉션 박스" }).getByRole("link").first().click();
  await expect(page.getByLabel("상품명")).toHaveValue("문라이트 컬렉션 박스");
  await shot(page, "SA-012-E-edit");

  await page.getByLabel("판매가").fill("129000");
  await page.getByLabel("옵션 1 재고").fill("9");
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했습니다")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("판매가")).toHaveValue("129000");
  await expect(page.getByLabel("옵션 1 재고")).toHaveValue("9");

  await page.getByRole("button", { name: "취소" }).first().click();
  const row = page.getByTestId("product-row").filter({ hasText: "문라이트 컬렉션 박스" });
  await expect(row).toContainText("129,000원");
  await expect(row).toContainText("9");

  // 되돌려 두어 다시 돌려도 같은 결과가 나오게 한다
  await row.getByRole("link").first().click();
  await page.getByLabel("판매가").fill("132000");
  await page.getByLabel("옵션 1 재고").fill("5");
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했습니다")).toBeVisible();
});

test("상품 삭제: 숨김을 먼저 권하고, 완전 삭제는 상품명을 넣어야 한다", async ({ page }) => {
  const name = track(`e2e ${stamp} 삭제용`);
  await login(page);
  await page.goto("/seller/products/new");
  await page.getByLabel("상품명").fill(name);
  await page.getByLabel("판매가").fill("1000");
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await searchFor(page, name);
  await page.getByTestId("product-row").filter({ hasText: name }).getByRole("link").first().click();

  await page.getByRole("button", { name: "삭제", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`「${name}」을 삭제하시겠습니까?`)).toBeVisible();
  await shot(page, "SA-012-D-delete");
  await dialog.getByRole("button", { name: "숨김으로 변경", exact: true }).click();
  await expect(page.getByText("숨김으로 변경했습니다")).toBeVisible();
  await expect(page.locator(".loc-bar .bdg")).toHaveText("숨김");

  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await dialog.getByText("완전 삭제").click();
  const confirm = dialog.getByRole("button", { name: "삭제", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("삭제할 상품명 입력").fill(name);
  await confirm.click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await expect(page.getByText("상품을 삭제했습니다")).toBeVisible();
  await searchFor(page, name);
  await expect(page.getByText(new RegExp(`^「${name} · \\d{4}-\\d{2}-\\d{2} ~ \\d{4}-\\d{2}-\\d{2}」에 해당하는 상품이 없습니다$`))).toBeVisible();
  await expect(page.getByTestId("product-row").filter({ hasText: name })).toHaveCount(0);
});

test("판매가를 내리면서 추가 금액을 바꿔도 저장된다(중간 상태가 늘 올바른 순서)", async ({ page }) => {
  const name = track(`e2e ${stamp} 가격 순서`);
  await login(page);
  await page.goto("/seller/products/new");
  await page.getByLabel("상품명").fill(name);
  await page.getByLabel("판매가").fill("10000");
  await page.getByLabel("옵션 1 이름").fill("낱개");
  await page.getByLabel("옵션 1 추가 금액").fill("-9000");
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await searchFor(page, name);
  await page.getByTestId("product-row").filter({ hasText: name }).getByRole("link").first().click();

  // 10000 / -9000 → 5000 / -4000 (판매가를 내림)
  await page.getByLabel("판매가").fill("5000");
  await page.getByLabel("옵션 1 추가 금액").fill("-4000");
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했습니다", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("판매가")).toHaveValue("5000");
  await expect(page.getByLabel("옵션 1 추가 금액")).toHaveValue("-4000");

  // 5000 / -4000 → 10000 / -9000 (판매가를 올림)
  await page.getByLabel("판매가").fill("10000");
  await page.getByLabel("옵션 1 추가 금액").fill("-9000");
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했습니다", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("판매가")).toHaveValue("10000");
  await expect(page.getByLabel("옵션 1 추가 금액")).toHaveValue("-9000");
});

test("숫자·글자 입력: 전각 숫자는 받고, 음수 가격과 보이지 않는 글자는 칸별로 안내한다", async ({ page }) => {
  await login(page);
  await page.goto("/seller/products/new");
  await page.getByLabel("상품명").fill("부스터\u200b팩");
  await page.getByLabel("판매가").fill("-5");
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page.getByText("가격은 1원 이상, 21억 원 이하로 입력해 주십시오")).toBeVisible();
  await expect(page.getByText("사용할 수 없는 글자가 들어 있습니다", { exact: false })).toBeVisible();
  // 판매가가 틀렸을 때 정상 옵션에는 단가 오류를 띄우지 않는다
  await expect(page.getByText("추가 금액을 더한 가격이", { exact: false })).toHaveCount(0);

  await page.getByLabel("상품명").fill("부스터 팩");
  await page.getByLabel("판매가").fill("１５０００");
  await expect(page.getByText("15,000원", { exact: true })).toBeVisible();
  await expect(page.getByText("가격은 1원 이상", { exact: false })).toHaveCount(0);
});

test("권한이 하나도 없는 직원에게는 권한이 필요한 메뉴가 보이지 않는다", async ({ page }) => {
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-none@example.com", PASSWORD);
  // 로그인 직후는 홈(/seller)이다. 상품 목록은 주소로 들어오면 권한 안내
  await expect(page).toHaveURL(/\/seller$/);
  await page.goto("/seller/products");
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toBeVisible();
  const side = page.getByRole("complementary", { name: "파트너스 메뉴" });
  for (const hidden of ["방송 대시보드", "상품", "주문", "입금 확인", "배송 · 송장", "영수증 · 세금계산서", "적립금", "회원 목록", "구매 제한", "방송 화면 꾸미기", "방송 기록", "알림 설정", "구독 · 결제", "직원 계정"]) {
    await expect(side.getByText(hidden, { exact: true })).toHaveCount(0);
  }
  // 「게시판」 대분류는 권한 없이 볼 수 있는 상품 리뷰(서버도 조회는 파트너스 계정 누구나) 때문에 남지만, 구매자 문의 메뉴는 없다
  // 「쇼핑몰 설정」은 모든 직원이 볼 수 있는 탭(쇼핑몰 정보)이 있어 보인다(MASTER 결정 2026-10-04)
  // 대분류는 상단 메뉴(GNB), 공지·도우미·내 계정은 상단 오른쪽 유틸에 있다
  const gnb = page.getByRole("navigation", { name: "주 메뉴" });
  await expect(gnb.locator(".gnb-i")).toHaveText(["홈", "고객", "마케팅", "설정"]);
  for (const shown of ["공지 · 문의", "도우미", "내 계정"]) {
    await expect(page.locator(".gnb").getByText(shown, { exact: true })).toBeVisible();
  }
});

test("상품 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  // 배송 담당 직원도 로그인하면 홈(/seller)이다. 상품 목록은 주소로 들어오면 권한 안내
  await page.goto("/seller/login");
  await submitSellerLogin(page, VIEWER, PASSWORD);
  await expect(page).toHaveURL(/\/seller$/);
  await page.goto("/seller/products");
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toBeVisible();
  await expect(page.getByRole("link", { name: "상품 등록" })).toHaveCount(0);
  // 권한이 없는 메뉴는 숨기고, 가진 권한(배송)과 대표자 전용 메뉴 구분을 따른다
  const side = page.getByRole("complementary", { name: "파트너스 메뉴" });
  await expect(side.getByText("상품", { exact: true })).toHaveCount(0);
  await expect(side.getByText("직원 계정", { exact: true })).toHaveCount(0);
  await shot(page, "SA-011-no-permission");
  // 「배송 · 송장」은 상단 대분류 「주문」 아래 왼쪽 메뉴에 있다
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "주문", exact: true }).click();
  await expect(side.getByText("배송 · 송장", { exact: true })).toBeVisible();
});

test("휴대폰 폭(390)에서는 메뉴가 서랍으로 열리고 상품이 카드로 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByTestId("product-card").first()).toBeVisible();
  await expect(page.locator(".tbl.p-table")).toBeHidden();
  await expect(page.locator(".p-cards")).toBeVisible();
  await expect(page.getByTestId("product-row").first()).toBeHidden();
  // 가로 스크롤이 생기지 않는다
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const cards = await page.getByTestId("product-card").evaluateAll((els) =>
    els.map((e) => {
      const name = e.querySelector(".p-name")!;
      return {
        h: Math.round(e.getBoundingClientRect().height),
        name: Math.round(name.getBoundingClientRect().top - e.getBoundingClientRect().top),
        len: name.textContent!.length,
        clamped: name.scrollHeight > name.clientHeight + 1,
      };
    }),
  );
  expect(new Set(cards.map((c) => c.h)).size).toBe(1);
  expect(new Set(cards.map((c) => c.name)).size).toBe(1);
  // 100자 이름은 3줄에서 말줄임된다
  expect(cards.find((c) => c.len === 100)?.clamped).toBe(true);

  await expect(page.getByRole("link", { name: "상품 목록", exact: true })).not.toBeInViewport();
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.locator(".lnb")).toHaveCSS("transform", "none");
  await page.getByRole("link", { name: "상품 목록", exact: true }).scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator(".lnb").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: "상품 목록", exact: true })).toBeInViewport();
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-shell-drawer-390.png" });
  await page.getByRole("button", { name: "메뉴 닫기" }).click();
  await expect(page.getByRole("link", { name: "상품 목록", exact: true })).not.toBeInViewport();

  // 지금 보고 있는 메뉴(상품 목록)를 눌러도 서랍이 닫힌다
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.getByRole("link", { name: "상품 목록", exact: true })).toBeInViewport();
  await page.getByRole("link", { name: "상품 목록", exact: true }).click();
  await expect(page.getByRole("link", { name: "상품 목록", exact: true })).not.toBeInViewport();
});

test("로그아웃 요청이 실패하면 화면에 남아 다시 시도하게 한다", async ({ page }) => {
  await login(page);
  await page.route("**/api/seller/auth/logout", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page.getByText("로그아웃하지 못했습니다. 다시 시도해 주십시오")).toBeVisible();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.unroute("**/api/seller/auth/logout");
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
});

test("로그인이 풀린 뒤 다른 탭·화면을 열면 로그인으로 보낸다", async ({ page }) => {
  await login(page);
  // 첫 화면 데이터를 다 받은 뒤 로그인을 끊는다(받는 도중에 끊으면 그 요청이 먼저 로그인으로 보낸다)
  await expect(page.getByTestId("product-row").first()).toBeVisible();
  await page.context().clearCookies();
  await applyStatus(page, "숨김");
  await expect(page).toHaveURL(/\/seller\/login\?next=%2Fseller%2Fproducts&reason=expired$/);
});

test("탭을 빨리 바꾸면 마지막으로 고른 탭 결과만 보인다", async ({ page }) => {
  await login(page);
  // 「숨김」 응답을 늦게 돌려준다
  await page.route("**/api/seller/products?status=HIDDEN", async (r) => {
    await new Promise((res) => setTimeout(res, 1500));
    await r.continue();
  });
  await applyStatus(page, "숨김");
  await applyStatus(page, "판매 중");
  await expect(page.getByTestId("product-row").filter({ hasText: "스타라이트 부스터 박스" })).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(page.getByTestId("product-row").filter({ hasText: "스타라이트 부스터 박스" })).toBeVisible();
  await expect(page.getByTestId("product-row").filter({ hasText: "문라이트 1탄 박스" })).toHaveCount(0);
  await expect(searchBox(page).getByRole("radio", { name: "판매 중", exact: true })).toBeChecked();
});

test("「재고 없음」·「재고 부족」으로 걸러 보면 서버 기준(합계 0 / 1~5)과 배지가 맞는다", async ({ page }) => {
  await login(page);
  await applyStatus(page, "전체", "재고 없음");
  await expect(page.getByTestId("product-row").filter({ hasText: "드래곤 소울 부스터" })).toBeVisible();
  await expect(page.getByTestId("product-row").filter({ hasText: "스타라이트 부스터 박스" })).toHaveCount(0);
  await applyStatus(page, "전체", "재고 부족");
  const low = page.getByTestId("product-row").filter({ hasText: "탑로더 25장" });
  await expect(low).toBeVisible();
  await expect(low.locator(".bdg")).toHaveText("재고 부족");
  await expect(page.getByTestId("product-row").filter({ hasText: "드래곤 소울 부스터" })).toHaveCount(0);
  // 판매 상태 탭과 함께 쓴다: 「숨김」 + 「재고 부족」은 해당 없음
  await applyStatus(page, "숨김", "재고 부족");
  await expect(page.getByText(/^「숨김 · 재고 부족 · \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}」에 해당하는 상품이 없습니다$/)).toBeVisible();
});

test("「품절로 설정」 탭은 판매 상태가 품절인 상품만, 배지와 이름이 맞는다", async ({ page }) => {
  await login(page);
  await applyStatus(page, "품절로 설정");
  const row = page.getByTestId("product-row").filter({ hasText: "드래곤 소울 부스터" });
  await expect(row).toBeVisible();
  await expect(row.locator(".bdg")).toHaveText("품절");
  await expect(page.getByTestId("product-row").filter({ hasText: "스타라이트 부스터 박스" })).toHaveCount(0);
});

test("로그아웃하면 로그인 화면으로 가고 다시 들어갈 수 없다", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await page.goto("/seller/products");
  await expect(page).toHaveURL(/\/seller\/login\?next=/);
});

test("상품 검색: 상품·옵션 이름으로 서버에서 찾고(대소문자 무시), 판매 상태 탭과 함께 쓸 수 있다", async ({ page }) => {
  await login(page);
  // 옵션 이름으로도 찾는다(「4포켓」은 보관용 카드 바인더의 옵션)
  await searchFor(page, "4포켓");
  await expect(page.getByTestId("product-row")).toHaveCount(1);
  await expect(page.getByTestId("product-row").first()).toContainText("보관용 카드 바인더");
  // 상품 이름 일부
  await searchFor(page, "문라이트");
  await expect(page.getByTestId("product-row")).toHaveCount(2);
  // 탭과 함께: 숨김 탭에서는 숨긴 「문라이트 1탄 박스」만
  await applyStatus(page, "숨김");
  await expect(page.getByTestId("product-row")).toHaveCount(1);
  await expect(page.getByTestId("product-row").first()).toContainText("문라이트 1탄 박스");
  // 없는 이름은 안내하고, 「전체 보기」로 검색까지 지운다
  await searchFor(page, "없는상품이름");
  await expect(page.getByText(/^「없는상품이름 · 숨김 · \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}」에 해당하는 상품이 없습니다$/)).toBeVisible();
  await page.getByRole("button", { name: "전체 보기" }).click();
  await expect(page.getByLabel("상품 검색")).toHaveValue("");
  await expect(page.getByTestId("product-row").filter({ hasText: "스타라이트 부스터 박스" })).toBeVisible();
  await shot(page, "SA-011-search");
});

test("상품 검색어는 50자까지: 입력은 50자에서 멈추고, 바꾼 뒤 50자를 넘으면 길이로 안내한다", async ({ page }) => {
  await login(page);
  await page.getByLabel("상품 검색").fill("가".repeat(51));
  await expect(page.getByLabel("상품 검색")).toHaveValue("가".repeat(50));
  await page.getByLabel("상품 검색").fill("㈜".repeat(50));
  await searchBox(page).getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("검색어는 50자까지 입력할 수 있습니다")).toBeVisible();
  await page.getByRole("button", { name: "검색 지우기" }).click();
  await expect(page.getByLabel("상품 검색")).toHaveValue("");
  await expect(page.getByTestId("product-row").first()).toBeVisible();
});
