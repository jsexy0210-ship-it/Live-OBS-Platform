import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { fillDateTime } from "./dateInput";
import { createSellerSession } from "../../lib/server/auth/session";

// 마스터 관리자 점검 모드(MA-083): 안내 문구 필수·종료 시각 검사, 켜기·끄기(확인 창), 서버 상태·공개 상태 반영. 설정은 최고관리자만 열린다.
// 점검을 켜면 이 서버의 파트너스·쇼핑몰이 막히므로, 시험은 끝에 반드시 끄고 DB 줄도 되돌린다. 폐기용 테스트 DB(이름이 _test로 끝남)에서만 돌린다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `mt-super-${run}@example.com`;
let db: PrismaClient;
let sellerId: string;
let otherSellerId: string;
let sellerToken: string;

const reset = () => db.platformMaintenance.updateMany({ where: { id: 1 }, data: { enabled: false, message: "", reason: "", startsAt: null, endsAt: null } });

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "대표", role: "SUPER_ADMIN" } });
  await db.platformAdmin.create({ data: { email: `mt-read-${run}@example.com`, passwordHash: await hashPassword(password), name: "조회", role: "READ_ONLY" } });
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
  const seller = await db.seller.create({ data: { slug: `mt-own-${run}`, shopName: "점검 배너 시험", status: "ACTIVE", planId: plan.id, trialEndsAt: new Date("2999-01-01") } });
  sellerId = seller.id;
  const user = await db.sellerUser.create({ data: { sellerId, email: `mt-owner-${run}@example.com`, name: "파트너스", passwordHash: await hashPassword(password), isOwner: true } });
  sellerToken = (await createSellerSession(db, sellerId, user.id, {}, user.credentialVersion)).token;
  otherSellerId = (await db.seller.create({ data: { slug: `mt-other-${run}`, shopName: "다른 파트너스", status: "ACTIVE", planId: plan.id, trialEndsAt: new Date("2999-01-01") } })).id;
  await db.broadcastSession.create({ data: { sellerId: otherSellerId, status: "LIVE" } });
  await reset();
});
test.afterAll(async () => {
  await reset();
  const fixtureIds = [sellerId, otherSellerId].filter(Boolean);
  if (fixtureIds.length) await db.broadcastSession.updateMany({ where: { sellerId: { in: fixtureIds }, status: "LIVE" }, data: { status: "ENDED", endedAt: new Date() } });
  await db.$disconnect();
});

async function login(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("최고관리자: 안내 문구 없이는 켤 수 없고, 켜면 점검 중·공개 상태에 반영되며, 끄면 꺼진다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/settings/maintenance");
  const state = page.getByTestId("maintenance-form");
  await expect(state).toContainText("꺼짐");
  const on = page.getByRole("button", { name: "지금 즉시 켜기" });
  await expect(on).toBeDisabled();

  await page.getByLabel("사유 *", { exact: true }).fill("정기 점검");
  await page.getByLabel("점검 화면 안내 문구").fill(`정기 점검 ${run}\n오전 3시까지입니다.`);
  await fillDateTime(page, "시작 시각", "2099-01-02T10:00");
  await fillDateTime(page, "종료 예정 시각", "2099-01-02T09:00");
  await expect(page.getByText("종료 예정 시각은 시작 시각보다 뒤여야 합니다.")).toBeVisible();
  await expect(on).toBeDisabled();
  await fillDateTime(page, "종료 예정 시각", "2099-01-02T11:00");

  await on.click();
  await page.getByRole("dialog").getByLabel("확인 *").fill("점검 시작");
  await page.getByRole("dialog").getByRole("button", { name: "실행" }).click();
  await expect(page.getByText("점검을 켰습니다.")).toBeVisible();
  await expect(state).toContainText("점검 중");
  await expect(page.getByTestId("maintenance-admin-banner")).toBeVisible();
  await expect(page.getByTestId("maintenance-admin-banner").getByRole("link", { name: "점검 종료" })).toHaveAttribute("href", "/admin/settings/maintenance");
  const row = await db.platformMaintenance.findUniqueOrThrow({ where: { id: 1 } });
  expect(row.enabled).toBe(true);
  expect(row.startsAt).toBeNull(); // 즉시 켜기는 폼에 남은 미래 예약 시각을 적용하지 않는다.
  expect(row.reason).toBe("정기 점검");
  expect(row.message).toContain(`정기 점검 ${run}`);
  await expect.poll(async () => (await (await page.request.get("/api/maintenance")).json()).active).toBe(true);
  for (const [width, height] of [[1440, 900], [1024, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.reload();
    await expect(page.getByTestId("maintenance-preview")).toBeVisible();
    const formBox = await page.getByTestId("maintenance-form-column").boundingBox();
    const asideBox = await page.getByTestId("maintenance-aside").boundingBox();
    expect(formBox).not.toBeNull();
    expect(asideBox).not.toBeNull();
    if (width === 390) expect(asideBox!.y).toBeGreaterThan(formBox!.y);
    else expect(asideBox!.x).toBeGreaterThan(formBox!.x);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `tests/e2e/screenshots/admin-maintenance-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "점검 종료" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "실행" }).click();
  await expect(page.getByText("점검을 종료했습니다.")).toBeVisible();
  await expect(state).toContainText("꺼짐");
  await expect(page.getByTestId("maintenance-admin-banner")).not.toBeVisible();
  expect((await db.platformMaintenance.findUniqueOrThrow({ where: { id: 1 } })).enabled).toBe(false);
  await expect.poll(async () => (await (await page.request.get("/api/maintenance")).json()).active).toBe(false);
});

test("마스터 점검 고정 띠는 다른 화면에도 표시되고 조회 전용에는 종료 CTA가 없다", async ({ page }) => {
  await page.clock.install();
  await db.platformMaintenance.update({ where: { id: 1 }, data: { enabled: true, message: "격리 시험 점검", startsAt: null } });
  try {
    await page.goto("/admin/login");
    await page.getByLabel("이메일").fill(`mt-read-${run}@example.com`);
    await page.getByLabel("비밀번호").fill(password);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId("maintenance-admin-banner")).toBeVisible();
    await expect(page.getByTestId("maintenance-admin-banner").getByRole("link", { name: "점검 종료" })).toHaveCount(0);
    for (const [width, height] of [[1440, 900], [1024, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      const banner = await page.getByTestId("maintenance-admin-banner").boundingBox();
      const body = await page.locator(".cs-body").boundingBox();
      expect(banner!.y).toBe(48);
      expect(body!.y).toBeGreaterThanOrEqual(banner!.y + banner!.height);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `tests/e2e/screenshots/maintenance-admin-global-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/maintenance", async (route) => {
      requests++;
      await gate;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture_unavailable"}' });
    });
    await page.evaluate(() => { for (let i = 0; i < 8; i++) window.dispatchEvent(new Event("onq:maintenance-changed")); });
    await expect.poll(() => requests).toBe(1); // 여러 갱신 신호가 같은 미완료 요청을 중복 실행하지 않는다.
    release();
    await expect(page.getByTestId("maintenance-admin-banner")).not.toBeVisible();
    await expect(page.locator(".gnb")).toBeVisible();
    await expect(page).toHaveURL(/\/admin$/); // 표시용 요청 실패가 기존 화면을 막거나 이동시키지 않는다.
    await expect.poll(() => requests).toBe(2); // 신호는 요청 종료 뒤 한 번만 다시 읽는다.
    await page.locator(".gnb").getByRole("button", { name: "로그아웃" }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    const afterUnmount = requests;
    await page.clock.runFor(31_000);
    expect(requests).toBe(afterUnmount); // 셸이 사라지면 폴링 타이머도 정리한다.
  } finally { await reset(); }
});

test("10분 전 파트너스 띠는 자기 LIVE 방송에만 표시되고 취소하면 사라진다", async ({ page }) => {
  const schedule = async (minutes: number) => db.platformMaintenance.update({ where: { id: 1 }, data: { enabled: true, message: "예약 점검 시험", startsAt: new Date(Date.now() + minutes * 60_000), endsAt: new Date(Date.now() + 3_600_000) } });
  await schedule(9);
  await page.context().addCookies([{ name: "lo_seller", value: sellerToken, url: String(test.info().project.use.baseURL) }]);
  try {
    const summary = page.waitForResponse((r) => r.url().endsWith("/api/seller/broadcast/summary") && r.status() === 200);
    await page.goto("/seller/home-overlay");
    expect((await (await summary).json()).broadcast).toBeNull();
    await expect(page.getByTestId("maintenance-seller-banner")).not.toBeVisible(); // 다른 tenant의 LIVE 방송은 경고 조건이 아니다.
    await db.broadcastSession.create({ data: { sellerId, status: "LIVE" } });
    for (const [width, height] of [[1440, 900], [1024, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.reload();
      await expect(page.getByTestId("maintenance-seller-banner")).toContainText("방송을 끝내 주십시오");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `tests/e2e/screenshots/maintenance-partner-warning-${width}.png`, fullPage: true });
    }
    await schedule(11);
    const outside = page.waitForResponse((r) => r.url().endsWith("/api/maintenance") && r.status() === 200);
    await page.reload();
    expect((await (await outside).json()).scheduled).toBe(true);
    await expect(page.getByTestId("maintenance-seller-banner")).not.toBeVisible();
    await reset();
    const cancelled = page.waitForResponse((r) => r.url().endsWith("/api/maintenance") && r.status() === 200);
    await page.reload();
    expect((await (await cancelled).json()).scheduled).toBe(false);
    await expect(page.getByTestId("maintenance-seller-banner")).not.toBeVisible();
  } finally { await reset(); }
});

test("예약 저장·취소는 실제 상태와 다건 이력에 반영되고 미연결 자동 처리는 켤 수 없다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/settings/maintenance");
  await page.getByLabel("사유 *", { exact: true }).fill("예약 취소 검증");
  await page.getByLabel("점검 화면 안내 문구").fill("예약된 점검 안내입니다.");
  await fillDateTime(page, "시작 시각", "2099-02-01T03:00");
  await fillDateTime(page, "종료 예정 시각", "2099-02-01T05:00");
  await expect(page.getByRole("checkbox")).toHaveCount(3);
  for (const checkbox of await page.getByRole("checkbox").all()) {
    await expect(checkbox).toBeDisabled();
    await expect(checkbox).not.toBeChecked();
  }
  await expect(page.getByRole("link", { name: "점검 공지 작성" })).toHaveAttribute("href", "/admin/support/notices/new");
  await page.getByRole("button", { name: "예약 저장", exact: true }).click();
  await expect(page.getByText("점검 예약을 저장했습니다.")).toBeVisible();
  await expect(page.getByTestId("maintenance-schedule")).toContainText("예약 취소 검증");
  await page.getByTestId("maintenance-schedule").getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "실행" }).click();
  await expect(page.getByText("점검 예약을 취소했습니다.")).toBeVisible();
  await expect(page.getByTestId("maintenance-schedule")).toContainText("예약된 점검이 없습니다.");
  await expect(page.getByTestId("maintenance-history")).toContainText("예약 취소");
  expect((await db.platformMaintenance.findUniqueOrThrow({ where: { id: 1 } })).enabled).toBe(false);
});

test("다른 곳에서 먼저 바꿨으면(버전 충돌) 안내하고 최신 설정을 다시 읽는다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/settings/maintenance");
  await expect(page.getByTestId("maintenance-form")).toContainText("꺼짐");
  await page.getByLabel("사유 *", { exact: true }).fill("정기 점검");
  await page.getByLabel("점검 화면 안내 문구").fill(`충돌 시험 ${run}`);
  await db.platformMaintenance.updateMany({ where: { id: 1 }, data: { version: { increment: 1 } } });
  await page.getByRole("button", { name: "지금 즉시 켜기" }).click();
  await page.getByRole("dialog").getByLabel("확인 *").fill("점검 시작");
  await page.getByRole("dialog").getByRole("button", { name: "실행" }).click();
  await expect(page.getByText(/먼저 바꿨|다른 곳|최신/)).toBeVisible();
  await expect(page.getByTestId("maintenance-form")).toContainText("꺼짐");
  expect((await db.platformMaintenance.findUniqueOrThrow({ where: { id: 1 } })).enabled).toBe(false);
});
