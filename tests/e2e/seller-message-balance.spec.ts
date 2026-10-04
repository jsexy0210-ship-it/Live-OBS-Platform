import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-081 발송 충전: 잔액·제공량·단가표·비용 안내·동의·잔액 부족 알림 기준·사용 내역. 카드 충전은 API가 없어 버튼이 잠겨 있다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

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

// 폐기용 DB를 처음 상태로: 충전 기능 꺼짐, 단가 0원, 잔액·내역·동의 없음
async function reset() {
  await withDb(async (db, sellerId) => {
    await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: false }, update: { chargingEnabled: false } });
    await db.messageChannelPrice.deleteMany({});
    await db.sellerMessageLedger.deleteMany({ where: { sellerId } });
    await db.sellerMessageFeeConsent.deleteMany({ where: { sellerId } });
    await db.sellerMessageBalance.deleteMany({ where: { sellerId } });
  });
}

async function open(page: Page) {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fmessage-balance");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/message-balance$/);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.afterAll(reset);

test("충전 기능이 꺼져 있으면 준비 중 안내를 보이고 충전·동의가 잠긴다. 잔액·제공량·비용 안내는 볼 수 있다", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByRole("link", { name: "발송 충전", exact: true })).toHaveAttribute("href", "/seller/settings/message-balance");
  await expect(page.getByTestId("charging-off")).toContainText("충전 기능을 준비하고 있습니다");
  await expect(page.getByTestId("paid-balance")).toHaveText("0원");
  await expect(page.getByTestId("free-balance")).toHaveText("0원");
  await expect(page.getByTestId("mail-quota")).toContainText("/");
  await expect(page.getByTestId("skipped")).toHaveText("0건");
  // 단가가 정해지지 않았으면 「[확정 전]」, 서식 문구가 그대로 보인다
  await expect(page.getByTestId("price-table")).toContainText("1통당 [확정 전]원");
  await expect(page.getByText("후불 청구, 외상, 잔액이 마이너스가 되는 일은 없습니다.", { exact: false })).toBeAttached();
  await expect(page.getByTestId("charge-button")).toBeDisabled();
  await expect(page.getByText("충전 기능 준비 중")).toBeVisible();
  await expect(page.getByLabel("발송 비용 안내를 확인했고 동의합니다")).toBeDisabled();
  await shot(page, "SA-081-charge");
  // 충전 기능이 꺼져 있는 동안은 서버도 동의를 막지 않지만 화면은 체크할 수 없다(요청도 가지 않는다)
});

test("충전 기능을 켠 뒤: 단가가 보이고, 동의 체크가 저장되며, 잔액 부족 알림 기준을 바꿔 저장한다. 충전 버튼은 카드 충전 전이라 잠겨 있다", async ({ page }) => {
  await reset();
  await withDb(async (db) => {
    await db.platformMessageSetting.update({ where: { id: 1 }, data: { chargingEnabled: true } });
    await db.messageChannelPrice.createMany({ data: [{ channel: "ALIMTALK", unitPrice: 12 }, { channel: "MAIL_TRANSACTIONAL", unitPrice: 3 }] });
  });
  await open(page);
  await expect(page.getByTestId("charging-off")).toHaveCount(0);
  await expect(page.getByTestId("price-table")).toContainText("1건당 12원");
  await expect(page.getByTestId("price-table")).toContainText("1통당 3원");
  await expect(page.getByTestId("charge-button")).toBeDisabled();
  await expect(page.getByText("동의에 체크하면 충전할 수 있습니다")).toBeVisible();

  const consent = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/seller/message-balance/consent"));
  await page.getByLabel("발송 비용 안내를 확인했고 동의합니다").check();
  const res = await consent;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ version: "2026-10-05" });
  await expect(page.getByText("발송 비용 안내 동의를 저장했습니다")).toBeVisible();
  await expect(page.getByText("동의 버전 2026-10-05", { exact: false })).toBeVisible();
  await expect(page.getByLabel("발송 비용 안내를 확인했고 동의합니다")).toBeDisabled();
  await expect(page.getByText("카드 충전은 준비 중입니다")).toBeVisible();
  await expect(page.getByTestId("charge-button")).toBeDisabled();

  // 잔액 부족 알림 기준: 잘못된 값은 막고, 바르면 저장되어 다시 열어도 그대로다
  await page.getByLabel("잔액 부족 알림 기준").fill("abc");
  await page.getByRole("button", { name: "기준 저장" }).click();
  await expect(page.getByText("숫자만 입력해 주십시오")).toBeVisible();
  await page.getByLabel("잔액 부족 알림 기준").fill("20000000");
  await page.getByRole("button", { name: "기준 저장" }).click();
  await expect(page.getByText("10,000,000원까지 정할 수 있습니다")).toBeVisible();
  await page.getByLabel("잔액 부족 알림 기준").fill("5000");
  const put = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/seller/message-balance"));
  await page.getByRole("button", { name: "기준 저장" }).click();
  expect((await put).status()).toBe(200);
  await expect(page.getByText("잔액 부족 알림 기준을 저장했습니다")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("잔액 부족 알림 기준")).toHaveValue("5000");
  // 잔액 0이 기준(5,000원)보다 적어 알림 띠가 보인다
  await expect(page.getByText("발송 충전 잔액이 5,000원 아래로 내려갔습니다.")).toBeVisible();
});

test("사용 내역: 충전·차감·복원이 최근 순으로 보이고 잔액 변동이 부호와 함께 보인다. 잔액 부족 미발송 건수도 보인다", async ({ page }) => {
  await reset();
  await withDb(async (db, sellerId) => {
    await db.sellerMessageBalance.create({ data: { sellerId, paidBalance: 4000, freeBalance: 500 } });
    const now = Date.now();
    await db.sellerMessageLedger.createMany({
      data: [
        { sellerId, type: "CHARGE", status: "SUCCEEDED", channel: null, quantity: 1, paidAmount: 5000, freeAmount: 0, idempotencyKey: "e2e-charge", reason: "카드 충전", actorType: "SYSTEM", createdAt: new Date(now - 3 * 3_600_000) },
        { sellerId, type: "DEBIT", status: "SUCCEEDED", channel: "ALIMTALK", quantity: 12, unitPrice: 12, paidAmount: -144, freeAmount: 0, idempotencyKey: "e2e-debit", reason: null, actorType: "SYSTEM", createdAt: new Date(now - 2 * 3_600_000) },
        { sellerId, type: "DEBIT", status: "REVERSED", channel: "SMS", quantity: 1, unitPrice: 30, paidAmount: -30, freeAmount: 0, idempotencyKey: "e2e-reversed", reason: null, actorType: "SYSTEM", createdAt: new Date(now - 1 * 3_600_000) },
      ],
    });
  });
  await open(page);
  await expect(page.getByTestId("paid-balance")).toHaveText("4,000원");
  await expect(page.getByTestId("free-balance")).toHaveText("500원");
  const rows = page.getByTestId("ledger-row");
  await expect(rows).toHaveCount(3);
  // 최근 순: 복원(문자) → 차감(알림톡) → 충전
  await expect(rows.nth(0)).toContainText("차감 · 복원");
  await expect(rows.nth(0)).toContainText("문자");
  await expect(rows.nth(1)).toContainText("알림톡");
  await expect(rows.nth(1)).toContainText("12건");
  await expect(rows.nth(1)).toContainText("−144원");
  await expect(rows.nth(2)).toContainText("충전");
  await expect(rows.nth(2)).toContainText("+5,000원");
  await shot(page, "SA-081-charge-ledger");
});

test("직원은 대표자 전용 안내를 보고, 충전 정보는 보이지 않는다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fmessage-balance");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/message-balance$/);
  await expect(page.getByText("필요한 권한: 대표자", { exact: false })).toBeVisible();
  await expect(page.getByTestId("paid-balance")).toHaveCount(0);
});
