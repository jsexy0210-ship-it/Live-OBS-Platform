import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-043 구매 제한: 주문이 막힌 구매자 목록과 「제한 풀기」를 실제 API로 확인한다.
// 제한은 자동 규칙(미입금 자동 취소 3회 등)으로만 생기므로, 폐기용 테스트 DB에 데모 구매자의 제한을 직접 넣는다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const NICK = "별빛사냥꾼";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function withDb<T>(fn: (db: PrismaClient, sellerId: string, buyerMemberId: string) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com", isOwner: true }, select: { sellerId: true } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: owner.sellerId, broadcastNickname: NICK, deletedAt: null }, select: { id: true } });
    return await fn(db, owner.sellerId, buyer.id);
  } finally {
    await db.$disconnect();
  }
}

// 걸려 있는 제한을 모두 끝난 것으로 돌리고, 데모 구매자에게 사유가 다른 제한 두 건을 새로 건다(풀기는 구매자 단위로 모두 푼다)
async function restrictDemoBuyer() {
  await withDb(async (db, sellerId, buyerMemberId) => {
    const now = Date.now();
    await db.buyerPurchaseRestriction.updateMany({ where: { sellerId, liftedAt: null }, data: { endsAt: new Date(now - 1000) } });
    await db.buyerPurchaseRestriction.createMany({
      data: [
        { sellerId, buyerMemberId, reason: "UNPAID_AUTO_CANCEL", startsAt: new Date(now - 86_400_000), endsAt: new Date(now + 29 * 86_400_000) },
        { sellerId, buyerMemberId, reason: "PAID_CANCEL", startsAt: new Date(now - 3_600_000), endsAt: new Date(now + 30 * 86_400_000) },
      ],
    });
  });
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

test("대표자: 막힌 구매자가 사유와 함께 한 줄로 보이고, 사유를 적어 풀면 목록에서 빠지고 다시 열어도 없다", async ({ page }) => {
  await restrictDemoBuyer();
  await page.goto("/seller/login?next=%2Fseller%2Fpurchase-restrictions");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/purchase-restrictions$/);

  await expect(page.getByRole("link", { name: "구매 제한", exact: true })).toHaveAttribute("href", "/seller/purchase-restrictions");
  const row = page.getByTestId("restriction-row").filter({ hasText: NICK });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("미입금 자동 취소 반복");
  await expect(row).toContainText("결제 후 취소 반복");
  await shot(page, "SA-043-restrictions");

  await row.getByRole("button", { name: "제한 풀기" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("구매 제한을 푸시겠습니까?");
  await dialog.getByLabel("사유 (선택)").fill("입금 확인 후 해제");
  const lift = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/lift"));
  await dialog.getByRole("button", { name: "제한 풀기" }).click();
  const res = await lift;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ reason: "입금 확인 후 해제" });
  await expect(page.getByText(`${NICK}의 구매 제한을 풀었습니다`)).toBeVisible();
  await expect(row).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("주문이 막힌 구매자가 없습니다")).toBeVisible();
  // 서버에도 남은 제한이 없다
  const left = await withDb((db, sellerId, buyerMemberId) => db.buyerPurchaseRestriction.count({ where: { sellerId, buyerMemberId, liftedAt: null, endsAt: { gt: new Date() } } }));
  expect(left).toBe(0);
});

test("이미 풀린 제한을 풀려고 하면 목록을 다시 맞춘다", async ({ page }) => {
  await restrictDemoBuyer();
  await page.goto("/seller/login?next=%2Fseller%2Fpurchase-restrictions");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  const row = page.getByTestId("restriction-row").filter({ hasText: NICK });
  await expect(row).toHaveCount(1);
  // 화면을 연 뒤 다른 곳에서 풀렸다
  await withDb((db, sellerId, buyerMemberId) => db.buyerPurchaseRestriction.updateMany({ where: { sellerId, buyerMemberId, liftedAt: null }, data: { liftedAt: new Date() } }));
  await row.getByRole("button", { name: "제한 풀기" }).click();
  const lift = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/lift"));
  await page.getByRole("dialog").getByRole("button", { name: "제한 풀기" }).click();
  expect((await lift).status()).toBe(404);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("주문이 막힌 구매자가 없습니다")).toBeVisible();
});

test("회원·적립금 권한이 없는 직원은 메뉴가 안 보이고, 주소로 들어와도 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fpurchase-restrictions");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/purchase-restrictions$/);
  await expect(page.getByText("필요한 권한: 회원·적립금", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "구매 제한", exact: true })).toHaveCount(0);
});
