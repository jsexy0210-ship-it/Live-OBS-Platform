import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 파트너스 대리 조회(MA-016): 사유 필수·확인 창, 새 창으로 읽기 전용 파트너스 화면 열기, 열린 대리 조회 안내와 끝내기, 권한(조회 전용은 버튼 없음), 운영·정지 아닌 상태는 버튼 없음.
// 계정·파트너스는 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { cs: `im-cs-${run}@example.com`, ro: `im-ro-${run}@example.com` };
const shop = `대리몰 ${run}`;
const ids: Record<string, string> = {};
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.cs, passwordHash, name: "상담", role: "CS" },
      { email: emails.ro, passwordHash, name: "조회", role: "READ_ONLY" },
    ],
  });
  ids.active = (await db.seller.create({ data: { slug: `im-a-${run}`, shopName: shop, status: "ACTIVE", approvedAt: new Date() } })).id;
  ids.pending = (await db.seller.create({ data: { slug: `im-p-${run}`, shopName: `대기 ${shop}`, status: "PENDING" } })).id;
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, email: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("CS: 사유 없이는 시작할 수 없고, 시작하면 새 창이 열리고 대리 조회 안내가 보이며, 끝내면 서버에서도 사라진다", async ({ page, context }) => {
  await login(page, emails.cs);
  await page.goto(`/admin/partners/${ids.active}`);
  await page.getByRole("button", { name: "대신 보기", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("읽기 전용");
  const start = dialog.getByRole("button", { name: "대신 보기 시작", exact: true });
  await expect(start).toBeDisabled();
  await dialog.getByLabel("사유").fill("결제 문의 확인");
  const popup = context.waitForEvent("page");
  await start.click();
  const opened = await popup;
  await expect(page.getByText("대신 보기를 시작했습니다.")).toBeVisible();
  await expect.poll(() => opened.url()).toContain("/seller");
  await opened.close();

  const strip = page.getByTestId("impersonation-active");
  await expect(strip).toContainText("이 파트너스 화면을 대신 보는 중입니다.");
  await expect(strip).toContainText("결제 문의 확인");
  const active = (await (await page.request.get("/api/admin/impersonation")).json()).active;
  expect(active.sellerId).toBe(ids.active);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-impersonate-1440.png" });

  await strip.getByRole("button", { name: "대신 보기 끝내기" }).click();
  await expect(page.getByText("대신 보기를 끝냈습니다.")).toBeVisible();
  await expect(strip).toHaveCount(0);
  expect((await (await page.request.get("/api/admin/impersonation")).json()).active).toBeNull();
});

test("조회 전용 역할과 운영·정지 상태가 아닌 쇼핑몰에는 「대리 조회」 버튼이 없다", async ({ page }) => {
  await login(page, emails.ro);
  await page.goto(`/admin/partners/${ids.active}`);
  await expect(page.getByTestId("partner-badges")).toContainText(shop);
  await expect(page.getByRole("button", { name: "대신 보기", exact: true })).toHaveCount(0);
  await page.context().clearCookies();
  await login(page, emails.cs);
  await page.goto(`/admin/partners/${ids.pending}`);
  await expect(page.getByTestId("partner-badges")).toContainText(`대기 ${shop}`);
  await expect(page.getByRole("button", { name: "대신 보기", exact: true })).toHaveCount(0);
});
