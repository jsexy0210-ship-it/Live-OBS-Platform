import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-060 쇼핑몰 정보 · 대표 색상(시안 design/project/SA-060.dc.html v256): 로고 아래 같은 폼의 한 줄, 칩 8개(첫 칸이 기본색)와 「흰 글자 대비」 안내.
// 칩을 누르면 바로 저장되고(기본색 칩은 null), 쇼핑몰 설정 권한이 없는 직원에게는 줄이 보이지 않는다. E2E_SCREENSHOTS=1이면 1440·1024·390 스크린샷을 남긴다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const URL_PATH = "/seller/settings/shop";

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
const reset = () => withDb((db, sellerId) => db.sellerBrandColor.deleteMany({ where: { sellerId } }));

async function open(page: Page, email = "demo-owner@example.com") {
  await page.goto(`/seller/login?next=${encodeURIComponent(URL_PATH)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${URL_PATH}$`));
}

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

const isPut = (r: { request(): { method(): string }; url(): string }) => r.request().method() === "PUT" && r.url().endsWith("/api/seller/brand-color");
const chip = (page: Page, name: string | RegExp) => page.getByRole("radio", { name });
// 칩을 누르면 확인 창(DS-CONFIRM)이 열리고 「바꾸기」를 눌러야 서버에 보낸다
async function pick(page: Page, name: string | RegExp) {
  await chip(page, name).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("대표 색상을 바꾸시겠습니까?");
  await dialog.getByRole("button", { name: "바꾸기", exact: true }).click();
}

test.afterAll(reset);

test("대표 색상: 칩 8개, 처음에는 기본색이 골라져 있고 흰 글자 대비가 보이며, 칩을 누르면 바로 저장되고 기본색 칩은 지운다", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByTestId("brand-chip")).toHaveCount(8);
  await expect(chip(page, "#5B3DF6 (기본색)")).toBeChecked();
  await expect(page.getByTestId("brand-hint")).toHaveText(/^버튼 · 강조 · 오버레이 기본색 · 흰 글자 대비 \d\.\d : 1 ✓$/);
  await shot(page, "SA-060-brand-color");

  // 다른 색: 바로 저장(PUT 한 번), 안내와 선택 표시가 바뀐다
  const put = page.waitForResponse(isPut);
  await pick(page, "#0F766E");
  const res = await put;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ color: "#0F766E" });
  await expect(page.getByText("대표 색상을 바꿨습니다 · 쇼핑몰에 바로 반영됩니다")).toBeVisible();
  await expect(chip(page, "#0F766E")).toBeChecked();
  await expect(chip(page, "#5B3DF6 (기본색)")).not.toBeChecked();

  await page.reload();
  await expect(chip(page, "#0F766E")).toBeChecked();

  // 같은 칩을 다시 눌러도 보내지 않고, 기본색 칩은 null로 지운다
  const clear = page.waitForResponse(isPut);
  await pick(page, "#5B3DF6 (기본색)");
  expect((await clear).request().postDataJSON()).toEqual({ color: null });
  await expect(chip(page, "#5B3DF6 (기본색)")).toBeChecked();
  await page.reload();
  await expect(chip(page, "#5B3DF6 (기본색)")).toBeChecked();
});

test("시안 밖의 저장된 색은 끝에 칩 하나로 보이고 선택되어 있으며, 칩을 고르면 바뀐다", async ({ page }) => {
  await reset();
  await withDb((db, sellerId) => db.sellerBrandColor.create({ data: { sellerId, color: "#123456" } }));
  await open(page);
  await expect(page.getByTestId("brand-chip")).toHaveCount(9);
  await expect(chip(page, "#123456")).toBeChecked();
  const put = page.waitForResponse(isPut);
  await pick(page, "#2A62D9");
  expect((await put).request().postDataJSON()).toEqual({ color: "#2A62D9" });
  await expect(page.getByTestId("brand-chip")).toHaveCount(8);
});

test("쇼핑몰 설정 권한이 없는 직원에게는 대표 색상 줄이 보이지 않는다", async ({ page }) => {
  await open(page, "demo-none@example.com");
  await expect(page.getByRole("heading", { name: "쇼핑몰 정보" }).first()).toBeVisible();
  await expect(page.getByTestId("brand-chip")).toHaveCount(0);
  await expect(page.getByText("대표 색상", { exact: true })).toHaveCount(0);
});
