import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// 본인확인 대기 안내(정본 SA-100 · SA-034 · SA-081 상태 변형, 문구는 AU-013과 같음).
// 마스터가 직접 추가했고 대표자 본인확인이 끝나지 않은 쇼핑몰은 직원 추가 · 적립금 실제 지급 켜기 · 충전금 결제가 막힌다(서버 403 identity_pending).
// 폐기용 테스트 DB에서 데모 쇼핑몰을 대기 상태로 바꿨다가 끝나면 원래대로 돌린다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

type Saved = { directCreatedByAdminId: string | null; directCreatedAt: Date | null; representativeVerifiedAt: Date | null; charging: boolean | null };
let saved: Saved | undefined;

async function withDb<T>(fn: (db: PrismaClient, sellerId: string) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com", isOwner: true }, select: { sellerId: true } });
    return await fn(db, owner.sellerId);
  } finally {
    await db.$disconnect();
  }
}

async function setPending(pending: boolean) {
  await withDb(async (db, sellerId) => {
    if (!saved) {
      const s = await db.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { directCreatedByAdminId: true, directCreatedAt: true, representativeVerifiedAt: true } });
      const m = await db.platformMessageSetting.findUnique({ where: { id: 1 } });
      saved = { ...s, charging: m ? m.chargingEnabled : null };
    }
    await db.seller.update({
      where: { id: sellerId },
      data: pending
        ? { directCreatedByAdminId: randomUUID(), directCreatedAt: new Date(), representativeVerifiedAt: null }
        : { directCreatedByAdminId: saved.directCreatedByAdminId, directCreatedAt: saved.directCreatedAt, representativeVerifiedAt: saved.representativeVerifiedAt },
    });
  });
}

async function setCharging(on: boolean) {
  await withDb((db) => db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: on }, update: { chargingEnabled: on } }));
}

test.afterAll(async () => {
  if (!saved) return;
  const s = saved;
  await withDb(async (db, sellerId) => {
    await db.seller.update({ where: { id: sellerId }, data: { directCreatedByAdminId: s.directCreatedByAdminId, directCreatedAt: s.directCreatedAt, representativeVerifiedAt: s.representativeVerifiedAt } });
    if (s.charging !== null) await db.platformMessageSetting.update({ where: { id: 1 }, data: { chargingEnabled: s.charging } });
  });
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function loginTo(page: Page, path: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(path)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}$`));
}

const NOTICE_TITLE = "대표자 본인확인이 아직 끝나지 않았습니다.";
const notice = (feature: string) => `${feature}는 본인확인을 마치면 쓸 수 있습니다 · 아이디 · 비밀번호 찾기는 쓸 수 없고 마스터 관리자가 초대 링크를 다시 발급해 드립니다`;

test("본인확인 대기 쇼핑몰: 직원 추가 · 적립금 실제 지급 켜기 · 충전하기가 같은 안내와 함께 잠기고 조회는 그대로다", async ({ page }) => {
  await setPending(true);
  await setCharging(true);

  // 직원 계정: 머리 「직원 추가」 잠금 + 제목 아래 안내, 기존 직원 목록은 그대로
  await loginTo(page, "/seller/staff");
  expect(await page.evaluate(async () => (await (await fetch("/api/seller/me")).json()).identityPending)).toBe(true);
  await expect(page.getByTestId("identity-pending")).toContainText(NOTICE_TITLE);
  await expect(page.getByTestId("identity-pending")).toContainText(notice("직원 추가"));
  await expect(page.getByRole("button", { name: "직원 추가", exact: true })).toBeDisabled();
  await expect(page.getByTestId("staff-row").first()).toBeVisible();
  await shot(page, "SA-100-pending");

  // 직원 추가 화면에 직접 들어가도 같은 안내 + 입력 잠금
  await page.goto("/seller/staff/new");
  await expect(page.getByTestId("identity-pending")).toContainText(notice("직원 추가"));
  await expect(page.locator("#sa-name")).toBeDisabled();
  await expect(page.getByRole("button", { name: "직원 계정 만들기" })).toBeDisabled();

  // 적립금 실제 지급 켜기: 「현재 꺼짐」 띠 자리에 안내, 켜기만 잠기고 켜기 전 확인은 그대로
  await page.goto("/seller/rewards/live-payout");
  await expect(page.getByTestId("identity-pending")).toContainText(notice("적립금 실제 지급 켜기"));
  await expect(page.getByTestId("live-status")).toHaveCount(0);
  await expect(page.getByTestId("live-on-button")).toBeDisabled();
  await expect(page.getByTestId("live-pending")).toBeVisible();
  // 켜기 조건이 충족돼도 서버가 막는다(실제 지급을 켜는 요청은 403 identity_pending)
  const live = await page.evaluate(async () => {
    const r = await fetch("/api/seller/reward-live-payout", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, confirm: true }) });
    return { status: r.status, error: (await r.json()).error };
  });
  expect(live).toEqual({ status: 403, error: "identity_pending" });
  await shot(page, "SA-034-pending");

  // 충전금: 머리 · 하단 「충전하기」 잠금, 잔액 · 사용 내역은 그대로
  await page.goto("/seller/settings/message-balance");
  await expect(page.getByTestId("identity-pending")).toContainText(notice("충전금 결제"));
  await expect(page.getByRole("button", { name: "충전하기" }).first()).toBeDisabled();
  await expect(page.getByTestId("charge-button")).toBeDisabled();
  await expect(page.getByTestId("charge-amount")).toBeDisabled();
  await expect(page.getByTestId("paid-balance")).toBeVisible();
  await shot(page, "SA-081-pending");
});

test("세션이 대기 여부를 모르면 눌렀을 때 서버 403 identity_pending으로 같은 안내를 보이고 직원은 만들어지지 않는다", async ({ page }) => {
  await setPending(true);
  // 화면이 미리 알지 못하는 경우(identityPending 값 없음)를 만든다: 서버 게이트는 그대로 둔다
  await page.route("**/api/seller/me", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    delete body.identityPending;
    await route.fulfill({ response: res, json: body });
  });
  await loginTo(page, "/seller/staff/new");
  await expect(page.getByTestId("identity-pending")).toHaveCount(0);
  const email = `pending-${Date.now()}@example.com`;
  await page.locator("#sa-name").fill("대기확인");
  await page.locator("#sa-phone").fill("010-1234-5678");
  await page.locator("#sa-email").fill(email);
  await page.locator("#sa-password").fill("Passw0rd1234");
  await page.getByRole("button", { name: "직원 계정 만들기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "직원 계정 만들기" }).click();
  await expect(page.getByTestId("identity-pending")).toContainText(notice("직원 추가"));
  await expect(page.locator("#sa-name")).toBeDisabled();
  expect(await withDb((db, sellerId) => db.sellerUser.count({ where: { sellerId, email } }))).toBe(0);
});

test("본인확인이 끝난 쇼핑몰에는 안내가 없고 직원 추가가 열려 있다", async ({ page }) => {
  await setPending(false);
  await loginTo(page, "/seller/staff");
  await expect(page.getByTestId("staff-row").first()).toBeVisible();
  await expect(page.getByTestId("identity-pending")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "직원 추가", exact: true })).toBeEnabled();
});
