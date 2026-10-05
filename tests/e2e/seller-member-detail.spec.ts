import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-042 회원 상세: 등급 직접 조정, 구매 제한 현황과 풀기. 데모 구매자(dev-seed)로 실제 API를 눌러 DB 상태까지 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const NICK = "카드왕";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function withDb<T>(fn: (db: PrismaClient, sellerId: string, memberId: string) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug: "demo-shop" } });
    const member = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, broadcastNickname: NICK, deletedAt: null } });
    return await fn(db, seller.id, member.id);
  } finally {
    await db.$disconnect();
  }
}

async function openDetail(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1200 });
  const id = await withDb(async (_db, _s, memberId) => memberId);
  await page.goto(`/seller/login?next=${encodeURIComponent(`/seller/members/${id}`)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page.getByRole("heading", { level: 1, name: NICK })).toBeVisible();
  return id;
}

test("등급 조정: 다른 등급으로 바꾸면 서버에 반영되고, 고정하면 종료일·사유와 함께 저장된다", async ({ page }) => {
  const id = await openDetail(page);
  const dd = page.locator("dt", { hasText: "등급" }).locator("xpath=following-sibling::dd[1]");
  const before = (await dd.textContent())!.trim();
  const apply = page.getByRole("button", { name: "등급 적용" });
  // 지금 등급 그대로면 적용할 수 없다
  await expect(apply).toBeDisabled();
  const select = page.getByLabel("등급", { exact: true }).last();
  const options = await select.locator("option").allTextContents();
  const other = options.find((o) => o !== before)!;
  await select.selectOption({ label: other });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText("등급을 조정했습니다", { exact: false })).toBeVisible();
  await expect(dd).toHaveText(other);

  // 원래 등급으로 되돌리면서 고정(종료일·사유)
  await select.selectOption({ label: before });
  await page.getByLabel("고정 (자동 재산정에서 제외)").check();
  await page.getByLabel("고정 종료일").fill("2099-12-31");
  await page.getByLabel("사유").fill("방송 단골");
  await apply.click();
  await expect(page.getByText("자동 재산정에서 제외")).toBeVisible();
  await expect(dd).toHaveText(before);
  const lock = await withDb((db) => db.memberGradeOverride.findUniqueOrThrow({ where: { buyerMemberId: id }, select: { until: true, reason: true } }));
  expect(lock.reason).toBe("방송 단골");
  expect(lock.until?.toISOString().startsWith("2099-12-3")).toBe(true);
  // 시험 뒤 고정을 풀어 둔다(다음 실행·다른 시험에 영향 없게)
  await withDb((db) => db.memberGradeOverride.deleteMany({ where: { buyerMemberId: id } }));
});

test("구매 제한: 막혀 있으면 사유·기간이 보이고, 풀면 제한 없음으로 바뀌며 서버에서도 풀린다", async ({ page }) => {
  await withDb(async (db, sellerId, buyerMemberId) => {
    const now = Date.now();
    await db.buyerPurchaseRestriction.updateMany({ where: { sellerId, buyerMemberId, liftedAt: null }, data: { endsAt: new Date(now - 1000) } });
    await db.buyerPurchaseRestriction.create({ data: { sellerId, buyerMemberId, reason: "UNPAID_AUTO_CANCEL", startsAt: new Date(now - 86_400_000), endsAt: new Date(now + 29 * 86_400_000) } });
  });
  await openDetail(page);
  const info = page.getByTestId("restriction-info");
  await expect(info).toContainText("미입금 자동 취소 반복");
  await page.getByRole("button", { name: "제한 풀기" }).click();
  const dialog = page.getByRole("dialog", { name: /구매 제한을 푸시겠습니까/ });
  await dialog.getByLabel("사유").fill("입금 확인 후 해제");
  await dialog.getByRole("button", { name: "제한 풀기" }).click();
  await expect(page.getByText("구매 제한을 풀었습니다")).toBeVisible();
  await expect(page.getByTestId("restriction-none")).toBeVisible();
  const left = await withDb((db, sellerId, buyerMemberId) => db.buyerPurchaseRestriction.count({ where: { sellerId, buyerMemberId, liftedAt: null, endsAt: { gt: new Date() } } }));
  expect(left).toBe(0);
});
