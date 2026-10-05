import { expect, test, type Page } from "@playwright/test";
import { resetCategoriesInDb } from "./categoryDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-015 카테고리: 데모 쇼핑몰에 시험용 카테고리(부스터 박스 › 프리미엄, 팩, 비공개 분류)를 넣고 실제 API로 추가·이름 바꾸기·노출·순서 저장·삭제를 눌러 본다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await resetCategoriesInDb(SLUG, true);
});
test.afterAll(() => resetCategoriesInDb(SLUG, false));

const login = async (page: Page, email: string) => {
  await page.goto("/seller/login?next=%2Fseller%2Fproducts%2Fcategories");
  await submitSellerLogin(page, email, PASSWORD);
};
const rows = (page: Page) => page.getByTestId("category-row");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const tree = (page: Page) => page.evaluate(async () => (await (await fetch("/api/seller/categories")).json()).categories as { name: string; visible: boolean; children: { name: string }[] }[]);

test("대표자: 트리를 보고, 추가·이름 바꾸기·노출·순서 저장·삭제를 서버에 반영한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/products\/categories$/);
  await expect(page.getByTestId("category-count")).toHaveText("대분류 3 · 하위 1");
  await expect(rows(page)).toHaveCount(4);
  await expect(row(page, "프리미엄")).toHaveAttribute("data-level", "2");
  await expect(row(page, "비공개 분류")).toContainText("숨김");
  // 쇼핑몰 미리보기: 꺼 둔 대분류는 안 보인다
  await expect(page.getByTestId("category-preview")).toContainText("부스터 박스");
  await expect(page.getByTestId("category-preview")).not.toContainText("비공개 분류");
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-015-categories-1440.png", fullPage: true });

  // 하위가 있는 대분류는 서버가 삭제를 막고, 서버 문구가 그대로 보인다
  await row(page, "부스터 박스").getByRole("button", { name: "삭제" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("하위 카테고리를 먼저 삭제해 주십시오")).toBeVisible();
  await expect(row(page, "부스터 박스")).toHaveCount(1);

  // 하위 추가 · 이름 30자 검사
  await row(page, "팩").getByRole("button", { name: "하위 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "하위 카테고리 추가" });
  await dialog.getByLabel("이름").fill("a".repeat(31));
  await expect(dialog.getByText("이름은 30자까지 입력할 수 있습니다")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "추가" })).toBeDisabled();
  await dialog.getByLabel("이름").fill("스타터 덱");
  await dialog.getByRole("button", { name: "추가" }).click();
  await expect(row(page, "스타터 덱")).toHaveAttribute("data-level", "2");
  expect((await tree(page)).find((c) => c.name === "팩")!.children.map((c) => c.name)).toEqual(["스타터 덱"]);

  // 이름 바꾸기
  await row(page, "스타터 덱").getByRole("button", { name: "이름 바꾸기" }).click();
  await page.getByRole("dialog").getByLabel("이름").fill("입문 덱");
  await page.getByRole("dialog").getByRole("button", { name: "저장" }).click();
  await expect(row(page, "입문 덱")).toHaveCount(1);

  // 노출 끄기: 서버 값이 바뀌고 미리보기에서 빠진다
  await page.getByRole("checkbox", { name: "팩 쇼핑몰 노출" }).click();
  await expect.poll(async () => (await tree(page)).find((c) => c.name === "팩")!.visible).toBe(false);
  await expect(page.getByTestId("category-preview")).not.toContainText("팩");

  // 순서: 옮기기만으로는 서버가 안 바뀌고, 「순서 저장」을 눌러야 바뀐다
  await expect(page.getByRole("button", { name: "순서 저장" })).toBeDisabled();
  await row(page, "팩").getByRole("button", { name: "위로" }).click();
  await expect(rows(page).first()).toContainText("팩");
  expect((await tree(page)).map((c) => c.name)[0]).toBe("부스터 박스");
  await page.getByRole("button", { name: "순서 저장" }).click();
  await expect(page.getByText("카테고리 순서를 저장했습니다 · 쇼핑몰에 바로 반영")).toBeVisible();
  expect((await tree(page)).map((c) => c.name)[0]).toBe("팩");
  await expect(page.getByRole("button", { name: "순서 저장" })).toBeDisabled();

  // 삭제: 하위부터 지우면 대분류도 지울 수 있다
  await row(page, "입문 덱").getByRole("button", { name: "삭제" }).click();
  await expect(page.getByRole("dialog")).toContainText("「입문 덱」을 삭제하시겠습니까?");
  await page.getByRole("dialog").getByRole("button", { name: "삭제" }).click();
  await expect(row(page, "입문 덱")).toHaveCount(0);
  expect((await tree(page)).find((c) => c.name === "팩")!.children).toHaveLength(0);
});

test("순서를 바꾸는 사이 다른 곳에서 목록이 바뀌면 저장이 막히고 새로 고침을 안내한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(rows(page).first()).toBeVisible();
  const first = await rows(page).first().locator("b").innerText();
  await rows(page).nth(0).getByRole("button", { name: "아래로" }).click();
  // 다른 창에서 대분류가 추가된 것처럼 서버 쪽을 바꾼다(요청에 쿠키가 붙는 같은 브라우저 문맥)
  await page.evaluate(async () => {
    const r = await fetch("/api/seller/categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "다른 창에서 추가" }) });
    if (!r.ok) throw new Error(String(r.status));
  });
  await page.getByRole("button", { name: "순서 저장" }).click();
  await expect(page.getByText("순서를 저장하지 못했습니다.")).toBeVisible();
  await page.getByRole("button", { name: "새로 고침" }).click();
  await expect(row(page, "다른 창에서 추가")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "순서 저장" })).toBeDisabled();
  expect(first).toBeTruthy();
});

test("상품 권한이 없는 직원은 서버가 막아 권한 안내가 보인다", async ({ page }) => {
  await login(page, "demo-none@example.com");
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toBeVisible();
  await expect(page.getByText("필요한 권한: 상품")).toBeVisible();
});
