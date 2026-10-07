import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { fillDateTime } from "./dateInput";

// 마스터 관리자 점검 모드(MA-083): 안내 문구 필수·종료 시각 검사, 켜기·끄기(확인 창), 서버 상태·공개 상태 반영. 설정은 최고관리자만 열린다.
// 점검을 켜면 이 서버의 파트너스·쇼핑몰이 막히므로, 시험은 끝에 반드시 끄고 DB 줄도 되돌린다. 폐기용 테스트 DB(이름이 _test로 끝남)에서만 돌린다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `mt-super-${run}@example.com`;
let db: PrismaClient;

const reset = () => db.platformMaintenance.updateMany({ where: { id: 1 }, data: { enabled: false, message: "", reason: "", startsAt: null, endsAt: null } });

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "대표", role: "SUPER_ADMIN" } });
  await reset();
});
test.afterAll(async () => {
  await reset();
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
  expect((await db.platformMaintenance.findUniqueOrThrow({ where: { id: 1 } })).enabled).toBe(false);
  await expect.poll(async () => (await (await page.request.get("/api/maintenance")).json()).active).toBe(false);
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
