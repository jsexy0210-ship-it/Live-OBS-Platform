import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 발송 단가(MA-086): 채널 7종 단가·변경 예정·플랫폼 메일 한도·충전 스위치. 계정은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const superEmail = `msg-super-${run}@example.com`;
const csEmail = `msg-cs-${run}@example.com`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: superEmail, passwordHash, name: "대표", role: "SUPER_ADMIN" },
      { email: csEmail, passwordHash, name: "상담", role: "CS" },
    ],
  });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function open(page: Page, email: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/settings/messages");
}
const row = (page: Page, label: string) => page.getByTestId("price-row").filter({ hasText: label });

test("채널 7종 단가가 이름으로 보이고, 단가 변경(바로·예정)과 입력 검사가 된다", async ({ page }) => {
  await open(page, superEmail);
  await expect(page.getByTestId("price-row")).toHaveCount(7);
  await expect(row(page, "거래 메일(월 제공량 초과분)")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("MAIL_TRANSACTIONAL");
  await expect(page.locator("main")).not.toContainText("IDENTITY_VERIFICATION");
  const align = await page.locator(".tbl td").first().evaluate((el) => getComputedStyle(el).textAlign);
  expect(["left", "start"]).toContain(align);

  await row(page, "단문 문자").getByRole("button", { name: "변경" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("단가").fill("100001");
  await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
  await dialog.getByLabel("단가").fill("12");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "단문 문자")).toContainText("12원");
  expect((await db.messageChannelPrice.findUniqueOrThrow({ where: { channel: "SMS" } })).unitPrice).toBe(12);

  // 적용 예정: 현재 단가는 그대로, 변경 후 단가와 적용 예정일이 보인다
  const future = new Date(Date.now() + 3 * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 16);
  await row(page, "단문 문자").getByRole("button", { name: "변경" }).click();
  await dialog.getByLabel("단가").fill("20");
  await dialog.getByLabel("적용 예정 시각").fill(future);
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toHaveCount(0);
  const sms = row(page, "단문 문자");
  await expect(sms.locator("td").nth(1)).toHaveText("12원");
  await expect(sms.locator("td").nth(2)).toHaveText("20원");
  await expect(sms.locator("td").nth(3)).not.toHaveText("-");
  const saved = await db.messageChannelPrice.findUniqueOrThrow({ where: { channel: "SMS" } });
  expect(saved.unitPrice).toBe(12);
  expect(saved.pendingUnitPrice).toBe(20);
});

test("플랫폼 메일 한도 저장과 충전 스위치: 확인 창을 거치고, 서버가 거절하면 안내하며 상태는 그대로다", async ({ page }) => {
  await open(page, superEmail);
  await expect(page.getByTestId("charging-state")).toHaveText("꺼짐");
  await page.getByLabel("하루 한도").fill("150");
  await page.getByLabel("월 한도").fill("4000");
  await page.getByRole("button", { name: "한도 저장" }).click();
  await expect(page.getByTestId("usage-today")).toContainText("/ 150통");
  await expect(page.getByTestId("usage-month")).toContainText("/ 4,000통");
  const s = await db.platformMessageSetting.findUniqueOrThrow({ where: { id: 1 } });
  expect([s.platformDailyLimit, s.platformMonthlyLimit]).toEqual([150, 4000]);

  await page.getByLabel("하루 한도").fill("abc");
  await page.getByRole("button", { name: "한도 저장" }).click();
  await expect(page.locator(".err[role=alert]")).toHaveText("한도는 0 이상의 정수로 입력해 주십시오.");

  await page.getByRole("button", { name: "충전 켜기" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "충전을 켜시겠습니까?" })).toBeVisible();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("charging-state")).toHaveText("꺼짐");

  // 정기 작업이 돌지 않는 시험 DB에서는 켜기가 거절된다(409)
  await page.getByRole("button", { name: "충전 켜기" }).click();
  await dialog.getByRole("button", { name: "충전 켜기" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("충전 정기 작업이 아직 돌지 않아 충전을 켤 수 없습니다");
  await expect(dialog.getByRole("button", { name: "취소" })).toBeEnabled();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(page.getByTestId("charging-state")).toHaveText("꺼짐");
  expect((await db.platformMessageSetting.findUniqueOrThrow({ where: { id: 1 } })).chargingEnabled).toBe(false);
});

test("CS는 메뉴가 없고 주소로 들어와도 권한 안내만 본다", async ({ page }) => {
  await open(page, csEmail);
  await expect(page.getByTestId("admin-no-access")).toHaveText("이 화면을 볼 권한이 없습니다");
  await expect(page.getByTestId("price-row")).toHaveCount(0);
});
