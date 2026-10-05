import { expect, test, type Page } from "@playwright/test";
import { resetCategoriesInDb } from "./categoryDb";
import { resetDisplayInDb } from "./displayDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-016 상품 진열: 홈 영역·목록 정렬과 옵션·추천 상품·카테고리 안 순서를 실제 API로 저장하고 서버 값으로 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await resetCategoriesInDb(SLUG, true);
  await resetDisplayInDb(SLUG, "문라이트 컬렉션 박스");
});
test.afterAll(async () => {
  await resetDisplayInDb(SLUG);
  await resetCategoriesInDb(SLUG, false);
});

const login = async (page: Page, email: string) => {
  await page.goto("/seller/login?next=%2Fseller%2Fproducts%2Fdisplay");
  await submitSellerLogin(page, email, PASSWORD);
};
const display = (page: Page) =>
  page.evaluate(async () => (await (await fetch("/api/seller/display")).json()) as { listSort: string; options: Record<string, boolean>; sections: { kind: string; title: string; visible: boolean; itemCount: number }[]; recommended: { name: string }[] });
const sectionRow = (page: Page, title: string) => page.getByTestId("section-row").filter({ has: page.getByRole("textbox", { name: `${title}`, exact: false }) });

test("대표자: 홈 영역을 추가·이름·순서·표시 설정하고 저장하면 서버에 반영된다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/products\/display$/);
  // 저장한 적이 없으면 서버 기본(추천 → 신상품)
  await expect(page.getByTestId("section-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "영역 저장" })).toBeDisabled();
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-016-display-1440.png", fullPage: true });

  // 베스트 영역 추가 → 이름 바꾸기 → 맨 위로 → 신상품 끄기 → 저장
  await page.getByLabel("영역 추가").selectOption("BEST");
  await page.getByRole("button", { name: "추가", exact: true }).click();
  await expect(page.getByTestId("section-row")).toHaveCount(3);
  // 같은 종류는 한 번만: 목록에서 사라진다
  await expect(page.getByLabel("영역 추가").locator("option", { hasText: "베스트" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "베스트 영역 이름" }).fill("인기 상품");
  await page.getByRole("button", { name: "인기 상품 위로" }).click();
  await page.getByRole("button", { name: "인기 상품 위로" }).click();
  await page.getByRole("checkbox", { name: "신상품 홈에 표시" }).uncheck();
  expect((await display(page)).sections).toHaveLength(2); // 저장 전에는 서버가 그대로다
  await page.getByRole("button", { name: "영역 저장" }).click();
  await expect(page.getByText("홈 진열 영역을 저장했습니다 · 쇼핑몰에 바로 반영")).toBeVisible();
  const saved = (await display(page)).sections;
  expect(saved.map((s) => [s.kind, s.title, s.visible])).toEqual([
    ["BEST", "인기 상품", true],
    ["RECOMMENDED", "추천 상품", true],
    ["NEW", "신상품", false],
  ]);
  await expect(page.getByRole("button", { name: "영역 저장" })).toBeDisabled();

  // 이름은 30자까지
  await page.getByRole("textbox", { name: "베스트 영역 이름" }).fill("가".repeat(31));
  await expect(page.getByText("영역 이름은 1~30자로 입력해 주십시오")).toBeVisible();
  await expect(page.getByRole("button", { name: "영역 저장" })).toBeDisabled();
});

test("대표자: 목록 기본 정렬과 진열 옵션을 저장한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await page.getByRole("combobox", { name: /^정렬/ }).selectOption("low");
  await page.getByRole("checkbox", { name: "품절 상품은 맨 뒤로" }).check();
  await page.getByRole("checkbox", { name: /방송 중 상품은 맨 앞으로/ }).check();
  await page.getByRole("button", { name: "정렬 · 옵션 저장" }).click();
  await expect(page.getByText("진열 옵션을 저장했습니다 · 쇼핑몰에 바로 반영")).toBeVisible();
  const d = await display(page);
  expect(d.listSort).toBe("low");
  expect(d.options).toEqual({ soldOutLast: true, hideSoldOut: false, liveFirst: true });
});

test("대표자: 추천 상품을 검색해 추가하고 순서를 바꿔 저장하고, 빼기도 저장한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page.getByText("추천할 상품이 없습니다")).toBeVisible();
  await page.getByRole("button", { name: "상품 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "추천 상품 추가" });
  await dialog.getByLabel("상품명 검색").fill("스타라이트");
  await dialog.getByTestId("picker-row").filter({ hasText: "스타라이트 부스터 박스" }).getByRole("button", { name: "추가" }).click();
  await dialog.getByLabel("상품명 검색").fill("문라이트");
  await dialog.getByTestId("picker-row").filter({ hasText: "문라이트 컬렉션 박스" }).first().getByRole("button", { name: "추가" }).click();
  await dialog.locator(".modal-f").getByRole("button", { name: "닫기" }).click();
  const rows = page.getByTestId("recommended-row");
  await expect(rows).toHaveCount(2);
  expect((await display(page)).recommended).toHaveLength(0); // 저장 전
  await rows.nth(1).getByRole("button", { name: "맨 위로" }).click();
  await expect(rows.first()).toContainText("문라이트 컬렉션 박스");
  await page.getByRole("button", { name: "추천 상품 저장" }).click();
  await expect(page.getByText("추천 상품을 저장했습니다 · 쇼핑몰에 바로 반영")).toBeVisible();
  expect((await display(page)).recommended.map((r) => r.name)).toEqual(["문라이트 컬렉션 박스", "스타라이트 부스터 박스"]);

  // 빼기: 확인 창 → 저장
  await rows.first().getByRole("button", { name: "빼기" }).click();
  await expect(page.getByRole("dialog")).toContainText("추천 상품에서 빼시겠습니까?");
  await page.getByRole("dialog").getByRole("button", { name: "빼기" }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "추천 상품 저장" }).click();
  await expect.poll(async () => (await display(page)).recommended.map((r) => r.name)).toEqual(["스타라이트 부스터 박스"]);
});

test("대표자: 카테고리 안 상품 순서를 바꿔 저장한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await page.getByRole("region", { name: "카테고리별 진열" }).getByRole("combobox").selectOption({ label: "부스터 박스" });
  const rows = page.getByTestId("category-product-row");
  await expect(rows).toHaveCount(2);
  const names = await rows.locator("td:nth-child(2)").allInnerTexts();
  await rows.nth(1).getByRole("button", { name: /위로$/ }).click();
  await page.getByRole("button", { name: "순서 저장" }).click();
  await expect(page.getByText("카테고리 안 순서를 저장했습니다 · 쇼핑몰에 바로 반영")).toBeVisible();
  const id = await page.evaluate(async () => (await (await fetch("/api/seller/categories")).json()).categories.find((c: { name: string }) => c.name === "부스터 박스").id);
  const after = await page.evaluate(async (id) => ((await (await fetch(`/api/seller/categories/${id}/products`)).json()).products as { name: string }[]).map((p) => p.name), id);
  expect(after).toEqual([names[1], names[0]]);
});

test("상품 권한이 없는 직원은 서버가 막아 권한 안내가 보인다", async ({ page }) => {
  await login(page, "demo-none@example.com");
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toBeVisible();
  await expect(page.getByText("필요한 권한: 상품")).toBeVisible();
});
