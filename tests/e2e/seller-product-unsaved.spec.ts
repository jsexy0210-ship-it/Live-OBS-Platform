import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// UX-04 상품 등록·수정 미저장 변경 경고: 바꾼 것이 있을 때만 링크·브라우저 Back에서 확인을 묻고, 원래대로 되돌리면 묻지 않는다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const WARN = "저장하지 않은 변경이 있습니다. 이 화면을 나가시겠습니까?";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

const login = async (page: Page, next: string) => {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
};
// 창이 뜨면 메시지를 모으고 answer로 답한다
const watchDialogs = (page: Page, answer: boolean) => {
  const seen: string[] = [];
  page.on("dialog", (d) => {
    seen.push(d.message());
    void (answer ? d.accept() : d.dismiss());
  });
  return seen;
};

test("등록 화면: 바꾼 것이 없으면 그냥 나가고, 입력하면 취소 링크에서 묻는다", async ({ page }) => {
  await login(page, "/seller/products/new");
  const seen = watchDialogs(page, false);
  await expect(page.getByLabel("상품명")).toBeVisible();
  await page.getByRole("button", { name: "취소" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  expect(seen).toEqual([]);

  await page.goto("/seller/products/new");
  await page.getByLabel("상품명").fill("미저장e2e 상품");
  await page.getByRole("button", { name: "취소" }).click();
  await expect.poll(() => seen).toEqual([WARN]);
  await expect(page).toHaveURL(/\/seller\/products\/new$/);
  await expect(page.getByLabel("상품명")).toHaveValue("미저장e2e 상품");
  // 지우면 변경이 없는 것으로 돌아와 묻지 않는다
  await page.getByLabel("상품명").fill("");
  await page.getByRole("button", { name: "취소" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  expect(seen).toEqual([WARN]);
});

test("수정 화면: 이름을 바꾸면 묻고, 원래대로 되돌리면 묻지 않는다", async ({ page }) => {
  await login(page, "/seller/products");
  await expect(page).toHaveURL(/\/seller\/products$/);
  const id = await page.evaluate(async () => (await (await fetch("/api/seller/products")).json()).products[0].id as string);
  await page.goto(`/seller/products/${id}`);
  const name = page.getByLabel("상품명");
  await expect(name).not.toHaveValue("");
  const original = await name.inputValue();
  const seen = watchDialogs(page, false);

  await name.fill(`${original}수정`);
  await page.getByRole("button", { name: "취소" }).click();
  await expect.poll(() => seen).toEqual([WARN]);
  await expect(page).toHaveURL(new RegExp(`/seller/products/${id}$`));

  await name.fill(original);
  await page.getByRole("button", { name: "취소" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  expect(seen).toEqual([WARN]);
});

test("브라우저 Back: 입력 중이면 묻고, 취소하면 머물며, 확인하면 이전 화면으로 간다", async ({ page }) => {
  await login(page, "/seller/products");
  await page.getByRole("link", { name: "상품 등록" }).first().click();
  await expect(page).toHaveURL(/\/seller\/products\/new$/);
  const seen: string[] = [];
  let answer = false;
  page.on("dialog", (d) => {
    seen.push(d.message());
    void (answer ? d.accept() : d.dismiss());
  });
  await page.getByLabel("상품명").fill("미저장e2e Back");
  await page.goBack();
  await expect.poll(() => seen).toEqual([WARN]);
  await expect(page).toHaveURL(/\/seller\/products\/new$/);
  answer = true;
  await page.goBack();
  await expect(page).toHaveURL(/\/seller\/products$/);
  expect(seen).toEqual([WARN, WARN]);
});

test("수정 화면: 저장하면 변경이 없는 것으로 돌아가 묻지 않는다(이름은 원래대로 되돌려 둔다)", async ({ page }) => {
  await login(page, "/seller/products");
  await expect(page).toHaveURL(/\/seller\/products$/);
  const id = await page.evaluate(async () => (await (await fetch("/api/seller/products")).json()).products[0].id as string);
  await page.goto(`/seller/products/${id}`);
  const name = page.getByLabel("상품명");
  await expect(name).not.toHaveValue("");
  const original = await name.inputValue();
  const seen = watchDialogs(page, false);
  try {
    await name.fill(`${original}저장`);
    await page.getByRole("button", { name: "저장", exact: true }).first().click();
    await expect(page.getByText("저장했습니다")).toBeVisible();
    await page.getByRole("button", { name: "취소" }).click();
    await expect(page).toHaveURL(/\/seller\/products$/);
    expect(seen).toEqual([]);
  } finally {
    await page.goto(`/seller/products/${id}`);
    await page.getByLabel("상품명").fill(original);
    await page.getByRole("button", { name: "저장", exact: true }).first().click();
    await expect(page.getByText("저장했습니다")).toBeVisible();
  }
});
