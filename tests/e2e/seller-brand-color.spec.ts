import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-060 쇼핑몰 정보 · 대표 색상: #RRGGBB 입력·저장·지우기, 흰 바탕 대비 3:1 미만은 서버가 거절. 쇼핑몰 설정 권한이 없는 직원에게는 구역이 보이지 않는다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const URL_PATH = "/seller/settings/shop";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function reset() {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com", isOwner: true }, select: { sellerId: true } });
    await db.sellerBrandColor.deleteMany({ where: { sellerId: owner.sellerId } });
  } finally {
    await db.$disconnect();
  }
}

async function open(page: Page, email = "demo-owner@example.com") {
  await page.goto(`/seller/login?next=${encodeURIComponent(URL_PATH)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${URL_PATH}$`));
}

const isPut = (r: { request(): { method(): string }; url(): string }) => r.request().method() === "PUT" && r.url().endsWith("/api/seller/brand-color");

test.afterAll(reset);

test("대표 색상: 처음에는 비어 있고, 잘못된 형식·너무 옅은 색은 저장되지 않으며, 진한 색은 저장되어 다시 열어도 그대로고 지울 수 있다", async ({ page }) => {
  await reset();
  await open(page);
  const input = page.getByLabel("대표 색상", { exact: true });
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("brand-save")).toBeDisabled();
  await expect(page.getByText("대표 색상을 저장하면 흰 바탕 대비가 표시됩니다")).toBeVisible();

  // 형식이 틀리면 이유를 보이고 저장 버튼이 눌리지 않는다
  await input.fill("#12");
  await expect(page.getByText("색상은 #RRGGBB 형식으로 입력해 주십시오")).toBeVisible();
  await expect(page.getByTestId("brand-save")).toBeDisabled();

  // 너무 옅은 색은 서버가 거절하고 안내를 보인다
  await input.fill("#ffff00");
  const bad = page.waitForResponse(isPut);
  await page.getByTestId("brand-save").click();
  expect((await bad).status()).toBe(400);
  await expect(page.getByText("너무 옅은 색입니다. 흰 바탕에서 잘 보이는 더 진한 색을 골라 주십시오")).toBeVisible();

  // 진한 색은 대문자로 저장된다
  await input.fill("#2563eb");
  const ok = page.waitForResponse(isPut);
  await page.getByTestId("brand-save").click();
  const res = await ok;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ color: "#2563EB" });
  await expect(page.getByText("대표 색상을 저장했습니다")).toBeVisible();
  await expect(input).toHaveValue("#2563EB");
  await expect(page.getByText(/저장된 색의 흰 바탕 대비 \d/)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("대표 색상", { exact: true })).toHaveValue("#2563EB");

  // 기본 색으로: null을 보낸다
  const clear = page.waitForResponse(isPut);
  await page.getByTestId("brand-clear").click();
  expect((await clear).request().postDataJSON()).toEqual({ color: null });
  await expect(page.getByText("대표 색상을 지웠습니다")).toBeVisible();
  await expect(page.getByLabel("대표 색상", { exact: true })).toHaveValue("");
  await expect(page.getByTestId("brand-clear")).toHaveCount(0);
});

test("쇼핑몰 설정 권한이 없는 직원에게는 대표 색상 구역이 보이지 않는다", async ({ page }) => {
  await open(page, "demo-none@example.com");
  await expect(page.getByRole("heading", { name: "쇼핑몰 정보" })).toBeVisible();
  await expect(page.getByText("로고", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("brand-save")).toHaveCount(0);
  await expect(page.getByText("대표 색상", { exact: true })).toHaveCount(0);
});
