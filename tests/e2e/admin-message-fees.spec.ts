import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { fillDateTime } from "./dateInput";

// 마스터 관리자 발송 단가(MA-086): 채널 11종 단가·변경 예정·플랫폼 메일 한도·충전 스위치. 계정은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
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

test("채널 11종 단가가 이름으로 보이고, 단가 변경(바로·예정)과 입력 검사가 된다", async ({ page }) => {
  await open(page, superEmail);
  await expect(page.getByTestId("price-row")).toHaveCount(11);
  await expect(row(page, "주문·배송 안내 메일(무료 수량을 넘은 것)")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("MAIL_TRANSACTIONAL");
  await expect(page.locator("main")).not.toContainText("IDENTITY_VERIFICATION");
  const align = await page.locator(".tbl td").first().evaluate((el) => getComputedStyle(el).textAlign);
  expect(align).toBe("center"); // 표 정렬 새 규칙(2026-10-05): 글 열(.col-text)이 아니면 데이터는 가운데

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
  await fillDateTime(dialog, "바뀌는 시각", future);
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

const JOB = "message.reconcile_and_release";

test("플랫폼 메일 한도 저장과 충전 스위치: 확인 창을 거치고, 서버가 거절하면 안내하며 상태는 그대로고, 정기 작업이 돌면 켜고 끌 수 있다", async ({ page }) => {
  // 충전 켜기는 발송 충전 정기 작업이 최근에 성공했어야 한다. 서버의 스케줄러가 돌았는지에 기대지 않도록 시험이 직접 정한다
  await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: false }, update: { chargingEnabled: false } });
  await db.opsHeartbeat.deleteMany({ where: { job: JOB } });
  await open(page, superEmail);
  await expect(page.getByTestId("charging-state")).toHaveText("꺼짐");
  // 같은 시험 DB로 다시 돌려도 값이 달라지도록 실행마다 다른 한도를 쓴다(저장 뒤 다시 읽기가 끝난 것을 값으로 확인하려고)
  const day = 200 + (parseInt(run, 16) % 700);
  const month = day * 30;
  await page.getByLabel("하루 한도").fill(String(day));
  await page.getByLabel("월 한도").fill(String(month));
  await page.getByRole("button", { name: "한도 저장" }).click();
  await expect(page.getByTestId("usage-today")).toContainText(`/ ${day.toLocaleString("ko-KR")}통`);
  await expect(page.getByTestId("usage-month")).toContainText(`/ ${month.toLocaleString("ko-KR")}통`);
  const s = await db.platformMessageSetting.findUniqueOrThrow({ where: { id: 1 } });
  expect([s.platformDailyLimit, s.platformMonthlyLimit]).toEqual([day, month]);

  await page.getByLabel("하루 한도").fill("abc");
  await page.getByRole("button", { name: "한도 저장" }).click();
  await expect(page.locator(".err[role=alert]")).toHaveText("한도는 0 이상의 숫자로 입력해 주십시오.");

  await page.getByRole("button", { name: "선불 충전 사용 켜기" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "선불 충전 사용을 켜시겠습니까?" })).toBeVisible();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("charging-state")).toHaveText("꺼짐");

  // 정기 작업이 돌지 않는 시험 DB에서는 켜기가 거절된다(409)
  await page.getByRole("button", { name: "선불 충전 사용 켜기" }).click();
  await dialog.getByRole("button", { name: "선불 충전 사용 켜기" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("발송·이용 충전 정기 작업이 아직 돌지 않아 충전을 켤 수 없습니다");
  await expect(dialog.getByRole("button", { name: "취소" })).toBeEnabled();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(page.getByTestId("charging-state")).toHaveText("꺼짐");
  expect((await db.platformMessageSetting.findUniqueOrThrow({ where: { id: 1 } })).chargingEnabled).toBe(false);

  // 정기 작업이 최근에 성공했다고 남기면 켜진다. 끄기는 언제든 된다
  const now = new Date();
  await db.opsHeartbeat.create({ data: { instance: `e2e-${run}`, generation: "g", job: JOB, lastRunAt: now, lastStatus: "done", lastOkAt: now } });
  try {
    await page.getByRole("button", { name: "선불 충전 사용 켜기" }).click();
    await dialog.getByRole("button", { name: "선불 충전 사용 켜기" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("charging-state")).toHaveText("켜짐");
    expect((await db.platformMessageSetting.findUniqueOrThrow({ where: { id: 1 } })).chargingEnabled).toBe(true);
    await page.getByRole("button", { name: "선불 충전 사용 끄기" }).click();
    await expect(dialog.getByRole("heading", { name: "선불 충전 사용을 끄시겠습니까?" })).toBeVisible();
    await dialog.getByRole("button", { name: "선불 충전 사용 끄기" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("charging-state")).toHaveText("꺼짐");
    expect((await db.platformMessageSetting.findUniqueOrThrow({ where: { id: 1 } })).chargingEnabled).toBe(false);
  } finally {
    await db.opsHeartbeat.deleteMany({ where: { instance: `e2e-${run}` } });
  }
});

test("CS는 메뉴가 없고 주소로 들어와도 권한 안내만 본다", async ({ page }) => {
  await open(page, csEmail);
  await expect(page.getByTestId("admin-no-access")).toHaveText("이 화면을 볼 권한이 없습니다");
  await expect(page.getByTestId("price-row")).toHaveCount(0);
});
