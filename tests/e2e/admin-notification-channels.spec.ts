import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 알림 채널(MA-082): 채널 4종·라우팅 10행이 서버 값으로 보이고, 체크를 바꾸면 확인 창을 거쳐 저장되며(새로고침에도 남음),
// 기본값 복원으로 되돌아오고, 긴급 이벤트는 야간 억제 칸이 「—」이다. 폐기용 테스트 DB(이름이 _test로 끝남)에서만 돌린다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `nc-super-${run}@example.com`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "대표", role: "SUPER_ADMIN" } });
  await db.adminNotificationRoute.deleteMany({});
});
test.afterAll(async () => {
  await db.adminNotificationRoute.deleteMany({});
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

test("채널 4종과 라우팅 10행이 보이고, 체크를 바꿔 저장하면 남고, 기본값 복원으로 되돌아온다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/settings/notifications");
  await expect(page.getByRole("heading", { name: "알림 채널", level: 1 })).toBeVisible();
  await expect(page.getByTestId("notify-channels").locator("tbody tr")).toHaveCount(4);
  await expect(page.getByTestId("notify-route")).toHaveCount(10);
  // 긴급 이벤트는 야간 억제를 켤 수 없다(칸이 「—」), 주의 이벤트는 체크 칸이 있다
  const urgent = page.getByTestId("notify-route").filter({ hasText: "플랫폼 장애" });
  await expect(urgent.getByRole("checkbox", { name: /야간 억제/ })).toHaveCount(0);
  await expect(urgent).toContainText("—");
  const row = page.getByTestId("notify-route").filter({ hasText: "적립금 지급 실패" });
  const sms = row.getByRole("checkbox", { name: "적립금 지급 실패 · 문자" });
  await expect(sms).not.toBeChecked();
  const save = page.getByRole("button", { name: "저장", exact: true });
  await expect(save).toBeDisabled();

  await sms.check();
  await expect(save).toBeEnabled();
  await page.getByRole("button", { name: "취소", exact: true }).click(); // 취소는 서버 값으로 되돌린다
  await expect(sms).not.toBeChecked();
  await expect(save).toBeDisabled();

  await sms.check();
  await save.click();
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("알림 라우팅을 저장했습니다")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("notify-route").filter({ hasText: "적립금 지급 실패" }).getByRole("checkbox", { name: "적립금 지급 실패 · 문자" })).toBeChecked();

  await page.getByRole("button", { name: "기본값 복원" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "기본값 복원" }).click();
  await expect(page.getByText("알림 라우팅을 기본값으로 되돌렸습니다")).toBeVisible();
  await expect(page.getByTestId("notify-route").filter({ hasText: "적립금 지급 실패" }).getByRole("checkbox", { name: "적립금 지급 실패 · 문자" })).not.toBeChecked();
});

test("테스트 보내기는 확인 창을 거치고, 연결 안 된 채널은 미연결로 알려 준다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/settings/notifications");
  await page.getByRole("button", { name: "테스트 보내기", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "테스트 보내기", exact: true }).click();
  await expect(page.getByText(/미연결: .*슬랙/)).toBeVisible();
});
