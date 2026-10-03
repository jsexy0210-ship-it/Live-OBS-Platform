import { expect, test, type Page } from "@playwright/test";

// 판매자 로그인 → 상품 목록 → 등록 → 수정 → 숨김·삭제를 실제로 눌러 확인한다.
// E2E_SCREENSHOTS=1이면 390·1440 화면을 tests/e2e/screenshots에 남긴다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const OWNER = "demo-owner@example.com";
const VIEWER = "demo-viewer@example.com";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const stamp = Date.now().toString(36);

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

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

async function login(page: Page, email = OWNER) {
  await page.goto("/seller/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
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
  await expect(page.getByText("이메일 또는 비밀번호가 맞지 않아요")).toBeVisible();
  await expect(page).toHaveURL(/\/seller\/login/);
  await shot(page, "AU-002-error");
});

test("상품 목록: 데모 상품·상태 배지·필터, 체험 배너가 보인다", async ({ page }) => {
  await login(page);
  await expect(page.getByText(/체험이 \d+일 남았어요/)).toBeVisible();
  await expect(page.locator(".topbar")).toContainText("카드숍 별빛");
  const rows = page.getByTestId("product-row");
  await expect(rows.filter({ hasText: "스타라이트 부스터 박스" })).toBeVisible();
  await expect(rows.filter({ hasText: "탑로더 25장" }).getByText("재고 부족")).toBeVisible();
  await expect(rows.filter({ hasText: "드래곤 소울 부스터" }).getByText("품절")).toBeVisible();
  // 목록 행 높이는 상품명 길이와 관계없이 같다
  const heights = await rows.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  await shot(page, "SA-011-list");

  await page.getByRole("tab", { name: "숨김" }).click();
  await expect(rows.filter({ hasText: "문라이트 1탄 박스" })).toBeVisible();
  await expect(rows.filter({ hasText: "스타라이트 부스터 박스" })).toHaveCount(0);
});

test("상품 등록 → 목록에 바로 보인다", async ({ page }) => {
  const name = `e2e 부스터 팩 ${stamp}`;
  await login(page);
  await page.getByRole("link", { name: "상품 등록" }).first().click();
  await expect(page).toHaveURL(/\/seller\/products\/new$/);
  await shot(page, "SA-012-new-empty");

  // 빈 칸 검사: 판매가가 숫자가 아니면 막는다
  await page.getByLabel("상품명").fill(name);
  await expect(page.getByTestId("name-count")).toHaveText(`${name.length}/100`);
  await page.getByLabel("판매가").fill("만오천원");
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page.getByText("숫자만 입력해 주세요")).toBeVisible();
  await expect(page.getByText(/아래 1개 항목을 확인해 주세요: 판매가/)).toBeVisible();
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
  await expect(page.getByText("상품을 등록했어요")).toBeVisible();
  const row = page.getByTestId("product-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("15,000원");
  await expect(row).toContainText("35");
  await expect(row).toContainText("판매 중");
});

test("상품명 100자를 넘기면 글자 수가 빨갛게 바뀌고 안내한다", async ({ page }) => {
  await login(page);
  await page.goto("/seller/products/new");
  await page.getByLabel("상품명").fill("가".repeat(101));
  await expect(page.getByTestId("name-count")).toHaveText("101/100");
  await expect(page.getByText("상품명은 100자까지 쓸 수 있어요")).toBeVisible();
});

test("상품 수정: 가격·재고를 바꾸면 저장되고 목록에도 반영된다", async ({ page }) => {
  await login(page);
  await page.getByTestId("product-row").filter({ hasText: "문라이트 컬렉션 박스" }).getByRole("link").click();
  await expect(page.getByLabel("상품명")).toHaveValue("문라이트 컬렉션 박스");
  await shot(page, "SA-012-E-edit");

  await page.getByLabel("판매가").fill("129000");
  await page.getByLabel("옵션 1 재고").fill("9");
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했어요")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("판매가")).toHaveValue("129000");
  await expect(page.getByLabel("옵션 1 재고")).toHaveValue("9");

  await page.getByRole("link", { name: "취소" }).first().click();
  const row = page.getByTestId("product-row").filter({ hasText: "문라이트 컬렉션 박스" });
  await expect(row).toContainText("129,000원");
  await expect(row).toContainText("9");

  // 되돌려 두어 다시 돌려도 같은 결과가 나오게 한다
  await row.getByRole("link").click();
  await page.getByLabel("판매가").fill("132000");
  await page.getByLabel("옵션 1 재고").fill("5");
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했어요")).toBeVisible();
});

test("상품 삭제: 숨김을 먼저 권하고, 완전 삭제는 상품명을 넣어야 한다", async ({ page }) => {
  const name = `e2e ${stamp} 삭제용`;
  await login(page);
  await page.goto("/seller/products/new");
  await page.getByLabel("상품명").fill(name);
  await page.getByLabel("판매가").fill("1000");
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.getByTestId("product-row").filter({ hasText: name }).getByRole("link").click();

  await page.getByRole("button", { name: "삭제", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`「${name}」을 삭제할까요?`)).toBeVisible();
  await shot(page, "SA-012-D-delete");
  await dialog.getByRole("button", { name: "숨김으로 바꾸기" }).click();
  await expect(page.getByText("숨김으로 바꿨어요")).toBeVisible();
  await expect(page.locator(".topbar .bdg")).toHaveText("숨김");

  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await dialog.getByText("완전 삭제").click();
  const confirm = dialog.getByRole("button", { name: "삭제", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("삭제할 상품명 입력").fill(name);
  await confirm.click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await expect(page.getByText("상품을 삭제했어요")).toBeVisible();
  await expect(page.getByTestId("product-row").filter({ hasText: name })).toHaveCount(0);
});

test("상품 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await login(page, VIEWER);
  await expect(page.getByText("이 기능은 권한이 필요해요")).toBeVisible();
  await expect(page.getByRole("link", { name: "상품 등록" })).toHaveCount(0);
  await shot(page, "SA-011-no-permission");
});

test("휴대폰 폭(390)에서는 메뉴가 서랍으로 열리고 상품이 카드로 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByTestId("product-card").first()).toBeVisible();
  await expect(page.getByTestId("product-row").first()).toBeHidden();
  // 가로 스크롤이 생기지 않는다
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const heights = await page.getByTestId("product-card").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);

  await expect(page.getByRole("link", { name: "상품", exact: true })).not.toBeInViewport();
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.getByRole("link", { name: "상품", exact: true })).toBeInViewport();
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-shell-drawer-390.png" });
  await page.getByRole("button", { name: "메뉴 닫기" }).click();
  await expect(page.getByRole("link", { name: "상품", exact: true })).not.toBeInViewport();
});

test("로그아웃하면 로그인 화면으로 가고 다시 들어갈 수 없다", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await page.goto("/seller/products");
  await expect(page).toHaveURL(/\/seller\/login\?next=/);
});
