import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-067 검색 노출: 검색 제목·설명, 검색 노출 끄기(확인 창), 사이트맵, 상품 규칙({상품명}·{쇼핑몰}만), 소유 확인 코드. 바뀐 항목만 보낸다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const URL_PATH = "/seller/settings/seo";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function withDb<T>(fn: (db: PrismaClient, sellerId: string) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com", isOwner: true }, select: { sellerId: true } });
    return await fn(db, owner.sellerId);
  } finally {
    await db.$disconnect();
  }
}

const reset = () => withDb((db, sellerId) => db.shopSeo.deleteMany({ where: { sellerId } }));

async function open(page: Page, email = "demo-owner@example.com") {
  await page.goto(`/seller/login?next=${encodeURIComponent(URL_PATH)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${URL_PATH}$`));
}

const isPut = (r: { request(): { method(): string }; url(): string }) => r.request().method() === "PUT" && r.url().endsWith("/api/seller/seo");

test.afterAll(reset);

test("기본값은 검색 노출·사이트맵 켬. 제목·설명·규칙·확인 코드를 입력하면 미리보기가 바뀌고, 바뀐 항목만 저장되어 다시 열어도 그대로다", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByRole("heading", { name: "검색 노출" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "검색 노출" }).getByRole("radio", { name: "허용", exact: true })).toBeChecked();
  await expect(page.getByLabel("사이트맵 제공", { exact: true })).toBeChecked();
  await expect(page.getByTestId("seo-save")).toBeDisabled();

  await page.getByLabel("검색 제목").fill("별빛 라이브 쇼핑");
  await page.getByLabel("검색 설명").fill("매주 금요일 라이브로 만나는 카드 쇼핑몰");
  await expect(page.getByTestId("seo-preview")).toContainText("별빛 라이브 쇼핑");
  await expect(page.getByTestId("seo-preview")).toContainText("매주 금요일 라이브로 만나는 카드 쇼핑몰");
  await page.getByLabel("상품 제목 규칙").fill("{상품명} | {쇼핑몰}");
  await page.getByLabel("구글 확인 코드").fill("abc_DEF-123");

  const put = page.waitForResponse(isPut);
  await page.getByTestId("seo-save").click();
  const res = await put;
  expect(res.status()).toBe(200);
  // 바뀐 항목만 보낸다(노출·사이트맵·설명 규칙·네이버 코드는 그대로라 빠진다)
  expect(res.request().postDataJSON()).toEqual({
    searchTitle: "별빛 라이브 쇼핑",
    searchDescription: "매주 금요일 라이브로 만나는 카드 쇼핑몰",
    productTitleTemplate: "{상품명} | {쇼핑몰}",
    googleVerification: "abc_DEF-123",
  });
  await expect(page.getByText("검색 노출 설정을 저장했습니다")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("검색 제목")).toHaveValue("별빛 라이브 쇼핑");
  await expect(page.getByLabel("상품 제목 규칙")).toHaveValue("{상품명} | {쇼핑몰}");
  await expect(page.getByLabel("구글 확인 코드")).toHaveValue("abc_DEF-123");

  // 비우면 지운다(null)
  await page.getByLabel("구글 확인 코드").fill("");
  const clear = page.waitForResponse(isPut);
  await page.getByTestId("seo-save").click();
  expect((await clear).request().postDataJSON()).toEqual({ googleVerification: null });
});

test("잘못된 입력은 저장하지 않고 이유를 보인다: 규칙의 알 수 없는 변수, 확인 코드 문자, 긴 제목", async ({ page }) => {
  await reset();
  await open(page);
  await page.getByLabel("상품 제목 규칙").fill("{가격} 할인");
  await page.getByLabel("네이버 확인 코드").fill("코드 값!");
  await page.getByLabel("검색 제목").fill("가".repeat(61));
  await page.getByTestId("seo-save").click();
  await expect(page.getByText("{상품명}, {쇼핑몰}만 쓸 수 있습니다")).toBeVisible();
  await expect(page.getByText("영문, 숫자, -, _ 만 입력할 수 있습니다")).toBeVisible();
  await expect(page.getByText("제목은 60자까지 입력할 수 있습니다")).toBeVisible();
});

test("검색 노출을 끄는 저장은 확인 창을 거치고, 끄면 안내 띠가 보인다. 다시 켜면 확인 없이 저장된다", async ({ page }) => {
  await reset();
  await open(page);
  await page.getByRole("radiogroup", { name: "검색 노출" }).getByRole("radio", { name: "허용 안 함" }).check();
  await page.getByTestId("seo-save").click();
  await expect(page.getByRole("dialog")).toContainText("검색 노출을 끄시겠습니까?");
  await page.getByRole("button", { name: "취소" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByTestId("seo-save").click();
  const put = page.waitForResponse(isPut);
  await page.getByTestId("seo-off-confirm").click();
  const res = await put;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ indexingEnabled: false });
  await expect(page.getByTestId("indexing-off")).toBeVisible();

  await page.getByRole("radiogroup", { name: "검색 노출" }).getByRole("radio", { name: "허용", exact: true }).check();
  const on = page.waitForResponse(isPut);
  await page.getByTestId("seo-save").click();
  expect((await on).request().postDataJSON()).toEqual({ indexingEnabled: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("indexing-off")).toHaveCount(0);
});

test("쇼핑몰 설정 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await open(page, "demo-none@example.com");
  await expect(page.getByText("필요한 권한: 쇼핑몰 설정", { exact: false })).toBeVisible();
  await expect(page.getByTestId("seo-save")).toHaveCount(0);
});
