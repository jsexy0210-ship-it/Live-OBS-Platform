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
const sectionRow = (page: Page, title: string) => page.getByTestId("section-row").filter({ hasText: title });

const SAVE_ALL = (page: Page) => page.getByRole("button", { name: "저장", exact: true });
const SAVED_TOAST = "진열 순서를 저장했습니다 · 홈에 바로 반영";

test("대표자: 홈 영역 6종 고정 표에서 번호 + ▲▼ · 홈에 표시를 바꿔 아래 「저장」 1회로 반영한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/products\/display$/);
  await expect(page.getByRole("heading", { name: "홈 진열", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "쇼핑몰 홈 보기" })).toHaveAttribute("href", `/shop/${SLUG}`);
  // 영역은 6종 고정(방송 상품 · 추천 · 신상품 · 베스트 · 할인 중 · 명예의 전당). 새로 만들기 · 이름 편집은 없다
  const rows = page.getByTestId("section-row");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(0)).toContainText("방송 상품 (자동)");
  await expect(rows.nth(0)).toContainText("1 · 맨 앞 고정");
  await expect(rows.nth(5)).toContainText("명예의 전당");
  await expect(rows.nth(5)).toContainText("6 · 맨 뒤 고정");
  await expect(page.getByRole("link", { name: "영역 추가", exact: true })).toHaveCount(0);
  await expect(rows.getByRole("textbox")).toHaveCount(0);
  // 고정 행에는 ▲▼가 없고, 맨 위 행의 ▲ · 맨 아래 행의 ▼는 꺼져 있다
  await expect(rows.nth(0).getByRole("button")).toHaveCount(0);
  await expect(rows.nth(5).getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "추천 상품 위로" })).toBeDisabled();
  // 저장한 적이 없으면 서버 기본(추천 → 신상품)만 보임
  await expect(sectionRow(page, "추천 상품").getByRole("checkbox", { name: "추천 상품 홈에 표시" })).toBeChecked();
  await expect(sectionRow(page, "베스트").getByRole("checkbox", { name: "베스트 홈에 표시" })).not.toBeChecked();
  await expect(SAVE_ALL(page)).toBeDisabled();
  // 보일 상품 수는 영역 표 안 입력(1~20): 추천 상품은 직접 고른 수라 읽기 전용, 명예의 전당은 「—」, 이름은 고칠 수 없다
  await expect(sectionRow(page, "추천 상품")).toContainText("0개 · 최대 20개");
  await expect(sectionRow(page, "추천 상품").getByRole("spinbutton")).toHaveCount(0);
  await expect(sectionRow(page, "명예의 전당")).toContainText("—");
  await expect(sectionRow(page, "신상품").getByRole("spinbutton", { name: "신상품 보일 상품 수" })).toHaveValue("8");
  await expect(sectionRow(page, "베스트").getByRole("spinbutton", { name: "베스트 보일 상품 수" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: /영역 이름/ })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-016-display-1440.png", fullPage: true });

  // 베스트 켜기(꺼진 채 없던 영역은 켜는 순간 초안에 들어간다) → ▲ 두 번 → 신상품 끄기 → 저장
  await sectionRow(page, "베스트").getByRole("checkbox", { name: "베스트 홈에 표시" }).check();
  await page.getByRole("button", { name: "베스트 위로" }).click();
  await page.getByRole("button", { name: "베스트 위로" }).click();
  await sectionRow(page, "신상품").getByRole("checkbox", { name: "신상품 홈에 표시" }).uncheck();
  await sectionRow(page, "신상품").getByRole("spinbutton", { name: "신상품 보일 상품 수" }).fill("12");
  expect((await display(page)).sections).toHaveLength(2); // 저장 전에는 서버가 그대로다
  await expect(SAVE_ALL(page)).toBeEnabled();
  await SAVE_ALL(page).click();
  await expect(page.getByText(SAVED_TOAST)).toBeVisible();
  const saved = (await display(page)).sections;
  expect(saved.map((s) => [s.kind, s.title, s.visible])).toEqual([
    ["BEST", "베스트", true],
    ["RECOMMENDED", "추천 상품", true],
    ["NEW", "신상품", false],
  ]);
  await expect(SAVE_ALL(page)).toBeDisabled();
});

test("대표자: 바꾼 순서가 있으면 나갈 때 공통 확인 창이 [계속 편집][저장 안 함]으로 묻는다(링크·브라우저 Back)", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/products\/display$/);
  const leave = page.getByRole("dialog", { name: "바꾼 순서를 저장하지 않고 나가시겠습니까?" });
  const before = JSON.stringify((await display(page)).sections);
  page.on("dialog", (d) => void d.dismiss()); // 브라우저 확인 창이 뜨면 이동이 막혀 아래 단언이 실패한다
  // 순서를 바꾸면 사이드 메뉴 링크를 눌러도 이동하지 않고 창이 뜬다
  await sectionRow(page, "할인 중").getByRole("checkbox", { name: "할인 중 홈에 표시" }).click(); // 앞 시험이 남긴 상태와 무관하게 무엇이든 바꾸면 변경이 생긴다
  await expect(SAVE_ALL(page)).toBeEnabled();
  await page.locator("aside a", { hasText: "카테고리" }).first().click();
  await expect(leave).toBeVisible();
  await expect(leave).toContainText("저장하지 않은 순서 변경이 사라집니다.");
  await expect(leave.locator(".modal-f button")).toHaveText(["계속 편집", "저장 안 함"]);
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await page.screenshot({ path: `tests/e2e/screenshots/SA-016-leave-confirm-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // 계속 편집: 그대로 남고 바꾼 순서도 남는다
  await leave.getByRole("button", { name: "계속 편집" }).click();
  await expect(leave).toHaveCount(0);
  await expect(page).toHaveURL(/\/seller\/products\/display$/);
  await expect(SAVE_ALL(page)).toBeEnabled();
  // 브라우저 Back도 같은 창
  await page.goBack();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "계속 편집" }).click();
  await expect(page).toHaveURL(/\/seller\/products\/display$/);
  // 저장 안 함: 이동하고 서버에는 아무것도 저장되지 않는다
  await page.locator("aside a", { hasText: "카테고리" }).first().click();
  await leave.getByRole("button", { name: "저장 안 함" }).click();
  await expect(page).toHaveURL(/\/seller\/products\/categories/);
  expect(JSON.stringify((await display(page)).sections)).toBe(before);
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
  await SAVE_ALL(page).click();
  await expect(page.getByText(SAVED_TOAST)).toBeVisible();
  expect((await display(page)).recommended.map((r) => r.name)).toEqual(["문라이트 컬렉션 박스", "스타라이트 부스터 박스"]);

  // 빼기: 확인 창 → 저장
  await rows.first().getByRole("button", { name: "빼기" }).click();
  await expect(page.getByRole("dialog")).toContainText("추천 상품에서 빼시겠습니까?");
  await page.getByRole("dialog").getByRole("button", { name: "빼기" }).click();
  await expect(rows).toHaveCount(1);
  await SAVE_ALL(page).click();
  await expect.poll(async () => (await display(page)).recommended.map((r) => r.name)).toEqual(["스타라이트 부스터 박스"]);
});

test("대표자: 카테고리 안 상품 순서를 바꿔 저장한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await page.getByRole("region", { name: "카테고리별 진열" }).getByRole("combobox").selectOption({ label: "부스터 박스" });
  const rows = page.getByTestId("category-product-row");
  await expect(rows).toHaveCount(2);
  const names = await rows.locator("td:nth-child(2)").allInnerTexts();
  await rows.nth(1).getByRole("button", { name: /위로$/ }).click();
  await SAVE_ALL(page).click();
  await expect(page.getByText(SAVED_TOAST)).toBeVisible();
  const id = await page.evaluate(async () => (await (await fetch("/api/seller/categories")).json()).categories.find((c: { name: string }) => c.name === "부스터 박스").id);
  const after = await page.evaluate(async (id) => ((await (await fetch(`/api/seller/categories/${id}/products`)).json()).products as { name: string }[]).map((p) => p.name), id);
  expect(after).toEqual([names[1], names[0]]);
});

test("상품 권한이 없는 직원은 서버가 막아 권한 안내가 보인다", async ({ page }) => {
  await login(page, "demo-none@example.com");
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toBeVisible();
  await expect(page.getByText("필요한 권한: 상품")).toBeVisible();
});

// 이미 저장된 카테고리 영역(과도기 · 읽기 전용)은 새로 만들거나 이름을 바꿀 수 없고, 다른 영역을 저장해도 지워지지 않는다
test("대표자: 저장된 카테고리 영역은 읽기 전용으로 보이고, 저장해도 그대로 남는다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page.getByRole("heading", { name: "홈 진열", exact: true })).toBeVisible();
  const catId = await page.evaluate(async () => (await (await fetch("/api/seller/categories")).json()).categories[0].id as string);
  const put = await page.evaluate(
    async (id) =>
      (await fetch("/api/seller/display/sections", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sections: [
        { kind: "RECOMMENDED", categoryId: null, title: "우리 추천", visible: true, itemCount: 8 },
        { kind: "CATEGORY", categoryId: id, title: "우리 카테고리", visible: true, itemCount: 6 },
      ] }) })).status,
    catId,
  );
  expect(put).toBe(200);
  await page.reload();
  await expect(page.getByTestId("category-section-row")).toHaveCount(1);
  await expect(page.getByTestId("category-section-row")).toContainText("우리 카테고리");
  await expect(sectionRow(page, "추천 상품")).toContainText("홈에서 쓰는 이름: 우리 추천");
  // 다른 영역(추천)을 바꿔 저장해도 카테고리 영역 · 바꾼 이름이 그대로 되돌아간다
  await sectionRow(page, "추천 상품").getByRole("checkbox", { name: "추천 상품 홈에 표시" }).uncheck();
  await SAVE_ALL(page).click();
  await expect(page.getByText(SAVED_TOAST)).toBeVisible();
  const after = (await display(page)).sections as { kind: string; title: string; visible: boolean; itemCount: number; categoryId?: string | null }[];
  expect(after.map((s) => [s.kind, s.title, s.visible, s.itemCount])).toEqual([
    ["RECOMMENDED", "우리 추천", false, 8],
    ["CATEGORY", "우리 카테고리", true, 6],
  ]);
});

// 저장된 영역이 10개(서버 한도)면 아직 없는 영역을 더 켤 수 없다 — 저장이 거절되어 막히는 일이 없게
test("대표자: 영역이 서버 한도(10개)에 차 있으면 새 영역을 켜지 못하고 안내가 보인다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page.getByRole("heading", { name: "홈 진열", exact: true })).toBeVisible();
  const catId = await page.evaluate(async () => (await (await fetch("/api/seller/categories")).json()).categories[0].id as string);
  const put = await page.evaluate(
    async (id) =>
      (await fetch("/api/seller/display/sections", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sections: [
        { kind: "RECOMMENDED", categoryId: null, title: "추천 상품", visible: true, itemCount: 8 },
        { kind: "NEW", categoryId: null, title: "신상품", visible: true, itemCount: 8 },
        ...Array.from({ length: 8 }, (_, i) => ({ kind: "CATEGORY", categoryId: id, title: `분류 ${i + 1}`, visible: true, itemCount: 4 })),
      ] }) })).status,
    catId,
  );
  expect(put).toBe(200);
  await page.reload();
  await expect(page.getByTestId("category-section-row")).toHaveCount(8);
  await sectionRow(page, "베스트").getByRole("checkbox", { name: "베스트 홈에 표시" }).click();
  await expect(page.getByText("영역은 10개까지 넣을 수 있습니다")).toBeVisible();
  await expect(sectionRow(page, "베스트").getByRole("checkbox", { name: "베스트 홈에 표시" })).not.toBeChecked();
  await expect(SAVE_ALL(page)).toBeDisabled();
});
