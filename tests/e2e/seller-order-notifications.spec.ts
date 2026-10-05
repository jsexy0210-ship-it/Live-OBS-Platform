import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { kstMonth } from "../../lib/server/mail/quota";
import { submitSellerLogin } from "./sellerLogin";

// SA-080 주문자 알림 중 「이번 달 제공량 사용 현황 · 발송·이용 충전금」 요약(GET /api/seller/message-balance).
const PASSWORD = process.env.E2E_PASSWORD ?? "";

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

async function reset() {
  await withDb(async (db, sellerId) => {
    await db.mailDelivery.deleteMany({ where: { sellerId } });
    await db.sellerMessageLedger.deleteMany({ where: { sellerId } });
    await db.sellerMessageBalance.deleteMany({ where: { sellerId } });
  });
}

async function open(page: Page) {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Forder-notifications");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/order-notifications$/);
}

test.afterAll(reset);

test("제공량 여유: 이번 달 사용량·잔액·알림 기준이 보이고 알림 띠는 없다", async ({ page }) => {
  await reset();
  await withDb((db, sellerId) => db.sellerMessageBalance.create({ data: { sellerId, paidBalance: 3000, freeBalance: 500, lowBalanceThreshold: 1000 } }));
  await open(page);
  await expect(page.getByRole("heading", { name: "주문자 알림" })).toBeVisible();
  await expect(page.getByTestId("quota")).toContainText("0 /");
  await expect(page.getByText("여유", { exact: true })).toBeVisible();
  await expect(page.getByTestId("balance")).toHaveText("3,500원");
  await expect(page.getByTestId("charged")).toHaveText("거래 메일 초과 0통");
  await expect(page.getByTestId("threshold")).toHaveText("잔액이 1,000원 아래로 내려가면 알립니다");
  await expect(page.getByTestId("skipped-note")).toHaveCount(0);
  await expect(page.getByTestId("exhausted-note")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "발송·이용 충전" }).first()).toHaveAttribute("href", "/seller/settings/message-balance");
});

test("잔액 부족 미발송이 있으면 보내지 못한 건수를 알리고, 거래 메일 제공량을 다 쓰면 소진 안내를 보인다", async ({ page }) => {
  await reset();
  // 이번 달 제공량만큼 보낸 것으로 만들고, 잔액 부족 미발송 2건을 남긴다
  const month = kstMonth(new Date());
  await open(page);
  const total = Number(((await page.getByTestId("quota").textContent()) ?? "").split("/")[1].replace(/[^0-9]/g, ""));
  expect(total).toBeGreaterThan(0);
  await withDb(async (db, sellerId) => {
    await db.mailDelivery.createMany({
      data: [
        ...Array.from({ length: total }, () => ({ sellerId, kind: "order_placed", month, status: "SENT" as const, charged: false })),
        { sellerId, kind: "order_shipped", month, status: "SKIPPED_BALANCE" as const, charged: false },
        { sellerId, kind: "order_shipped", month, status: "SKIPPED_BALANCE" as const, charged: false },
      ],
    });
  });
  await page.reload();
  await expect(page.getByTestId("skipped-note")).toContainText("알림 2건을 보내지 못했습니다");
  await expect(page.getByTestId("exhausted-note")).toContainText("제공량을 다 써서");
  await expect(page.getByText("제공량 소진")).toBeVisible();
});

test("직원은 대표자 전용 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Forder-notifications");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/order-notifications$/);
  await expect(page.getByText("필요한 권한: 대표자", { exact: false })).toBeVisible();
  await expect(page.getByTestId("quota")).toHaveCount(0);
});
