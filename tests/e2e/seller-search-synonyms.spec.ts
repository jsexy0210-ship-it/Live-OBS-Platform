import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 검색 유사어·상품 검색 키워드: 묶음을 쓰는 중에는 서버가 그대로이고 저장해야 바뀐다. 규칙 위반은 저장 전에 칸에서 안내한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

const login = async (page: Page, email: string, next: string) => {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
};
const groupsOnServer = (page: Page) => page.evaluate(async () => (await (await fetch("/api/seller/shop-search/synonyms")).json()).groups as { words: string[] }[]);
const putGroups = (page: Page, groups: { words: string[] }[]) =>
  page.evaluate(async (g) => (await fetch("/api/seller/shop-search/synonyms", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ groups: g }) })).status, groups);

test("대표자: 묶음을 추가해 저장하면 서버에 반영되고, 쓰는 중에는 서버가 그대로다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/products/search-synonyms");
  await expect(page.getByRole("heading", { name: "검색 유사어" })).toBeVisible();
  await expect(page).toHaveURL(/search-synonyms$/);
  await putGroups(page, []);
  await page.reload();
  try {
    await page.getByRole("button", { name: "묶음 추가" }).click();
    await page.getByLabel("묶음 1").fill("노트북, 랩탑, 랩탑");
    expect(await groupsOnServer(page)).toEqual([]);
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByText("검색 유사어를 저장했습니다")).toBeVisible();
    expect(await groupsOnServer(page)).toEqual([{ words: ["노트북", "랩탑"] }]);
    // 저장 뒤에는 변경이 없어 저장 버튼이 잠긴다
    await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();

    // 규칙: 단어가 1개면 저장 때 칸에서 안내하고 서버는 그대로
    await page.getByRole("button", { name: "묶음 추가" }).click();
    await page.getByLabel("묶음 2").fill("모니터");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByText("같은 뜻의 말을 2개 이상 쉼표로 적어 주십시오")).toBeVisible();
    // 다른 묶음과 같은 단어
    await page.getByLabel("묶음 2").fill("랩탑, 컴퓨터");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByText("「랩탑」은 다른 묶음에도 있습니다")).toBeVisible();
    expect(await groupsOnServer(page)).toEqual([{ words: ["노트북", "랩탑"] }]);

    // 쓰다 만 변경이 있으면 링크로 나갈 때 묻는다
    let asked = "";
    page.once("dialog", (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await page.getByRole("link", { name: "상품 목록" }).first().click();
    await expect.poll(() => asked).toContain("저장하지 않은 변경");
    await expect(page).toHaveURL(/search-synonyms$/);
  } finally {
    await putGroups(page, []);
  }
});

test("상품 관리 권한이 없는 직원은 권한 없음 안내를 본다", async ({ page }) => {
  await login(page, "demo-viewer@example.com", "/seller/products/search-synonyms");
  await expect(page).toHaveURL(/search-synonyms$/);
  await expect(page.getByText("상품 관리")).toBeVisible();
});

test("상품 폼 검색 키워드: 저장하면 서버 searchTags가 바뀌고, 20자 초과는 저장 전에 안내한다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/products");
  await expect(page).toHaveURL(/\/seller\/products$/);
  const id = await page.evaluate(async () => (await (await fetch("/api/seller/products")).json()).products[0].id as string);
  const tagsOnServer = () => page.evaluate(async (id) => (await (await fetch(`/api/seller/products/${id}`)).json()).searchTags as string[], id);
  await page.goto(`/seller/products/${id}`);
  const tags = page.getByLabel("검색 키워드");
  await expect(tags).toBeVisible();
  const before = await tagsOnServer();
  try {
    await tags.fill("선물, 한정판, 선물");
    expect(await tagsOnServer()).toEqual(before);
    await page.getByRole("button", { name: "저장", exact: true }).first().click();
    await expect(page.getByText("저장했습니다")).toBeVisible();
    expect(await tagsOnServer()).toEqual(["선물", "한정판"]);

    await tags.fill("가".repeat(21));
    await page.getByRole("button", { name: "저장", exact: true }).first().click();
    await expect(page.getByText("검색 키워드는 하나에 20자까지 입력할 수 있습니다").first()).toBeVisible();
    expect(await tagsOnServer()).toEqual(["선물", "한정판"]);
  } finally {
    await page.goto(`/seller/products/${id}`);
    await page.getByLabel("검색 키워드").fill(before.join(", "));
    await page.getByRole("button", { name: "저장", exact: true }).first().click();
    await expect(page.getByText("저장했습니다")).toBeVisible();
  }
});
