import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 대신 보기 띠·범위 밖 화면·만료 임박 안내(MA-016). 마스터 계정·파트너스는 폐기용 테스트 DB에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `imb-cs-${run}@example.com`;
const shop = `범위몰 ${run}`;
let sellerId = "";
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "상담", role: "CS" } });
  sellerId = (await db.seller.create({ data: { slug: `imb-${run}`, shopName: shop, status: "ACTIVE", approvedAt: new Date() } })).id;
});
test.afterAll(async () => {
  await db.$disconnect();
});

// 마스터로 로그인한 같은 브라우저에서 대신 보기를 시작한다(쿠키는 /api/seller 경로 전용이라 화면의 me 요청에만 실린다)
async function startViewing(page: Page, baseURL: string, scopes: string[]) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  const res = await page.request.post(`/api/admin/sellers/${sellerId}/impersonate`, { data: { reason: "방송 화면 확인", scopes }, headers: { origin: baseURL } });
  expect(res.status()).toBe(200);
}

test("띠에 고른 범위가 보이고, 범위 밖 화면은 「볼 수 없는 화면입니다」 안내만 보인다", async ({ page, baseURL }) => {
  await startViewing(page, baseURL!, ["OVERLAY"]);
  await page.goto("/seller");
  const bar = page.locator(".imp-bar");
  await expect(bar).toContainText("읽기 전용 · 대신 보기");
  await expect(bar).toContainText("범위: 오버레이");
  await page.goto("/seller/orders");
  const blocked = page.getByTestId("imp-out-of-scope");
  await expect(blocked).toContainText("볼 수 없는 화면입니다.");
  await expect(blocked).toContainText("사유를 적을 때 고른 범위만 볼 수 있습니다");
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await page.screenshot({ path: `tests/e2e/screenshots/MA-016-out-of-scope-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/overlay");
  await expect(page.locator(".imp-bar")).toBeVisible();
  await expect(page.getByTestId("imp-out-of-scope")).toHaveCount(0);
  // 표에 없는 화면(연동)과 복수형 방송 이력도 고르지 않은 범위면 막는다
  for (const path of ["/seller/external-shops", "/seller/broadcasts"]) {
    await page.goto(path);
    await expect(page.getByTestId("imp-out-of-scope")).toBeVisible();
  }
});

test("끝나기 2분 전부터 「N분 후 대신 보기가 종료됩니다」가 보이고, 그 전에는 보이지 않는다", async ({ page, baseURL }) => {
  await startViewing(page, baseURL!, ["ORDERS"]);
  let leftSeconds = 600;
  await page.route("**/api/seller/me", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, impersonation: { ...body.impersonation, expiresAt: new Date(Date.now() + leftSeconds * 1000).toISOString() } } });
  });
  await page.goto("/seller");
  await expect(page.locator(".imp-bar")).toContainText("범위: 주문");
  await expect(page.getByText("분 후 대신 보기가 종료됩니다")).toHaveCount(0);
  leftSeconds = 90;
  await page.reload();
  await expect(page.getByText("2분 후 대신 보기가 종료됩니다")).toBeVisible();
  leftSeconds = 30;
  await page.reload();
  await expect(page.getByText("1분 후 대신 보기가 종료됩니다")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/MA-016-soon-1440.png" });
});
