import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { randomInt } from "node:crypto";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-021 주문 목록 부분 환불 표기(결제 칸 「부분 환불」 · 금액 아래 「환불 n원」)와 주문번호 보조 표시, SA-022 주문번호 복사.
// 시험용 주문 한 건을 폐기용 DB에 직접 만든다(5,000원만 환불한 결제 완료 주문).
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

test("주문 목록·상세: 부분 환불 표기와 주문번호 보조 표시·복사", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const orderNo = 800000 + randomInt(100000);
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  let label = "";
  let sellerId = "";
  try {
    const seller = await db.seller.findFirstOrThrow({ where: { users: { some: { email: "demo-owner@example.com" } } } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null } });
    sellerId = seller.id;
    const now = new Date();
    await db.order.create({
      data: { sellerId: seller.id, orderNo, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "부분환불시험", totalAmount: 23000, paidAt: now, status: "PAID", refundAmount: 5000, createdAt: now },
    });
  } finally {
    await db.$disconnect();
  }

  try {
    await page.goto("/seller/login?next=%2Fseller%2Forders");
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/orders$/);
    const row = page.getByTestId("order-row").filter({ has: page.locator(".ord-ono", { hasText: new RegExp(`-${orderNo}$`) }) });
    await expect(row).toBeVisible();
    await expect(row.getByText("부분 환불", { exact: true })).toBeVisible();
    await expect(row.getByText("환불 5,000원")).toBeVisible();
    // 주문번호 보조 표시: 「yyyyMMdd-」 + 번호(4자리 이상)
    label = (await row.locator(".ord-ono").innerText()).trim();
    expect(label).toMatch(new RegExp(`^\\d{8}-${orderNo}$`));

    await row.getByRole("link").first().click();
    await expect(page.getByTestId("order-no-label")).toHaveText(label);
    await page.getByRole("button", { name: "복사" }).click();
    await expect(page.getByText("주문번호를 복사했습니다")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(label);
  } finally {
    // 다른 주문 시험(맨 위 행 · 건수)에 영향을 주지 않게 시험 주문을 지운다
    const cleanup = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
    try {
      await cleanup.order.deleteMany({ where: { sellerId, orderNo } });
    } finally {
      await cleanup.$disconnect();
    }
  }
});
