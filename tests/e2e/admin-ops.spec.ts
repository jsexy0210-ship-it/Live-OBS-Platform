import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 운영 현황(MA-041·042·043, 조회만). 계정·파트너스·방송은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const cs = `ops-cs-${run}@example.com`;
const names = { on: `접속몰 ${run}`, off: `끊김몰 ${run}`, idle: `대기몰 ${run}`, pay: `실지급몰 ${run}` };
let db: PrismaClient;

async function seller(key: keyof typeof names, extra: { live?: boolean; seen?: Date | null; payout?: Date } = {}) {
  const s = await db.seller.create({ data: { slug: `ops-${key}-${run}`, shopName: names[key], status: "ACTIVE", approvedAt: new Date() } });
  if (extra.live) await db.broadcastSession.create({ data: { sellerId: s.id, status: "LIVE", title: `방송 ${key} ${run}`, startedAt: new Date(Date.now() - 75 * 60_000) } });
  if (extra.seen !== undefined) await db.overlayToken.create({ data: { sellerId: s.id, tokenHash: randomBytes(16).toString("hex"), lastSeenAt: extra.seen } });
  if (extra.payout) await db.rewardPolicy.create({ data: { sellerId: s.id, livePayoutEnabled: true, livePayoutChangedAt: extra.payout } });
  return s;
}

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email: cs, passwordHash: await hashPassword(password), name: "상담", role: "CS" } });
  await seller("on", { live: true, seen: new Date() });
  await seller("off", { live: true, seen: new Date(Date.now() - 10 * 60_000) });
  await seller("idle");
  await seller("pay", { payout: new Date("2026-09-01T03:00:00Z") });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(cs);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("실시간 방송: 방송 중인 파트너스만 오버레이 상태와 함께 보이고, 「문제 있음만」은 접속 안 된 방송만 남긴다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/ops/live");
  const on = page.getByTestId("live-row").filter({ hasText: names.on });
  const off = page.getByTestId("live-row").filter({ hasText: names.off });
  await expect(on).toContainText("접속 중");
  await expect(on).toContainText("1시간 15분");
  await expect(off).toContainText("접속 안 됨");
  await expect(page.getByTestId("live-row").filter({ hasText: names.idle })).toHaveCount(0);
  await page.getByLabel("방송 화면이 연결되지 않은 방송만").check();
  await expect(on).toHaveCount(0);
  await expect(off).toHaveCount(1);
  await expect(page.getByTestId("live-status")).toContainText("10초마다 새로고침");
  await page.screenshot({ path: "tests/e2e/screenshots/admin-ops-live-1440.png" });
});

test("실시간 방송: 읽지 못하면 「갱신 끊김」을 알리고 마지막으로 읽은 내용은 그대로 둔다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/ops/live");
  await expect(page.getByTestId("live-row").filter({ hasText: names.on })).toBeVisible();
  await page.route("**/api/admin/ops/live-broadcasts", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await expect(page.getByTestId("live-status")).toContainText("자동 새로고침 멈춤", { timeout: 15_000 });
  await expect(page.getByTestId("live-row").filter({ hasText: names.on })).toBeVisible();
});

test("주문·오버레이 접속: 이용 중 파트너스가 보이고 「방송 중만」「오버레이 접속 안 됨」으로 거른다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/ops/access");
  const row = (n: string) => page.getByTestId("activity-row").filter({ hasText: n });
  // 가입 최신 순 50곳씩이라 이 실행의 파트너스가 첫 쪽에 있다
  await expect(row(names.on)).toContainText("방송 중");
  await expect(row(names.idle)).toBeVisible();
  await page.getByLabel("방송 중만").check();
  await expect(row(names.idle)).toHaveCount(0);
  await page.getByLabel("방송 화면 연결 안 됨").check();
  await expect(row(names.on)).toHaveCount(0);
  await expect(row(names.off)).toContainText("접속 안 됨");
  await expect(page.getByTestId("act-created")).toContainText("건");
});

test("적립금 실지급 파트너스: 켠 파트너스만 켠 날짜와 남은 적립금과 함께 보인다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/ops/rewards");
  const row = page.getByTestId("payout-row").filter({ hasText: names.pay });
  await expect(row).toContainText("2026.09.01");
  await expect(row).toContainText("0원");
  await expect(page.getByTestId("payout-row").filter({ hasText: names.idle })).toHaveCount(0);
  await expect(page.getByTestId("pay-count")).toContainText("곳");
});
