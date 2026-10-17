import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 실시간 방송 강제 종료(MA-041, 서버 POST /api/admin/ops/live-broadcasts/{id}/end): 운영·최고관리자만 버튼이 보이고, 사유가 있어야 종료된다.
// 계정·파트너스·방송은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const ops = `fe-ops-${run}@example.com`;
const cs = `fe-cs-${run}@example.com`;
const shop = `종료몰 ${run}`;
let db: PrismaClient;
let broadcastId = "";

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: ops, passwordHash, name: "운영", role: "OPERATIONS" },
      { email: cs, passwordHash, name: "상담", role: "CS" },
    ],
  });
  const s = await db.seller.create({ data: { slug: `fe-${run}`, shopName: shop, status: "ACTIVE", approvedAt: new Date() } });
  const b = await db.broadcastSession.create({ data: { sellerId: s.id, status: "LIVE", title: `방송 ${run}`, startedAt: new Date(Date.now() - 10 * 60_000) } });
  broadcastId = b.id;
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, who: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(who);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("CS(조회 계열)는 강제 종료 버튼이 보이지 않는다", async ({ page }) => {
  await login(page, cs);
  await page.goto("/admin/ops/live");
  const row = page.getByTestId("live-row").filter({ hasText: shop });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "강제 종료" })).toHaveCount(0);
});

test("운영: 사유 없이는 종료할 수 없고, 사유를 쓰면 종료·토스트·목록에서 빠지며, 이미 끝난 방송은 409로 안내한다", async ({ page }) => {
  await login(page, ops);
  await page.goto("/admin/ops/live");
  const row = page.getByTestId("live-row").filter({ hasText: shop });
  await row.getByRole("button", { name: "강제 종료" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("방송을 강제 종료하시겠습니까?");
  const confirm = dialog.getByRole("button", { name: "강제 종료" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("사유 (필수)").fill("시험 종료");
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: "tests/e2e/screenshots/MA-041-force-end-dialog-1440.png" });
  // 같은 방송을 다른 곳에서 먼저 끝내면 서버가 409(not_live)를 준다 → 창을 닫고 안내
  await db.broadcastSession.update({ where: { id: broadcastId }, data: { status: "ENDED", endedAt: new Date() } });
  await confirm.click();
  await expect(page.getByText("이미 끝난 방송입니다")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
});

test("운영: 사유를 쓰고 강제 종료하면 방송이 종료되고 목록에서 빠진다", async ({ page }) => {
  const s2 = await db.seller.create({ data: { slug: `fe2-${run}`, shopName: `종료몰2 ${run}`, status: "ACTIVE", approvedAt: new Date() } });
  const b2 = await db.broadcastSession.create({ data: { sellerId: s2.id, status: "LIVE", title: `방송2 ${run}`, startedAt: new Date(Date.now() - 5 * 60_000) } });
  await login(page, ops);
  await page.goto("/admin/ops/live");
  const row = page.getByTestId("live-row").filter({ hasText: `종료몰2 ${run}` });
  await row.getByRole("button", { name: "강제 종료" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("사유 (필수)").fill("송출 중단 요청");
  await dialog.getByRole("button", { name: "강제 종료" }).click();
  await expect(page.getByText("방송을 종료했습니다")).toBeVisible();
  await expect(row).toHaveCount(0);
  expect((await db.broadcastSession.findUnique({ where: { id: b2.id } }))?.status).not.toBe("LIVE");
});
