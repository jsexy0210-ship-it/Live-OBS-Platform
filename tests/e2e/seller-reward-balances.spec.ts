import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-033 회원별 적립금 잔액: 조회만(GET /api/seller/reward-balances). 닉네임 검색, 누적 값, 「더 보기」.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
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

async function reset() {
  await withDb(async (db, sellerId) => {
    await db.rewardLedger.deleteMany({ where: { sellerId } });
    await db.rewardBalance.deleteMany({ where: { sellerId } });
  });
}

async function open(page: Page) {
  await page.goto("/seller/login?next=%2Fseller%2Frewards%2Fbalances");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/rewards\/balances$/);
}

test.afterAll(reset);

test("잔액: 현재 잔액과 성공 내역 누적(적립·사용·회수·소멸·조정)이 보이고, 닉네임으로 찾을 수 있다. 지급·회수 버튼은 없다", async ({ page }) => {
  await reset();
  const now = Date.now();
  await withDb(async (db, sellerId, buyerMemberId) => {
    await db.rewardBalance.create({ data: { sellerId, buyerMemberId, balance: 700 } });
    const row = (type: "EARN" | "USE" | "REVOKE" | "EXPIRE" | "ADJUST", amount: number, status: "SUCCEEDED" | "FAILED", key: string) => ({
      sellerId, buyerMemberId, type, amount, status, testMode: false, idempotencyKey: key, createdAt: new Date(now - 3_600_000), processedAt: new Date(now - 3_600_000),
    });
    await db.rewardLedger.createMany({
      data: [
        row("EARN", 2000, "SUCCEEDED", "e2e-bal-earn"),
        row("USE", -800, "SUCCEEDED", "e2e-bal-use"),
        row("REVOKE", -300, "SUCCEEDED", "e2e-bal-revoke"),
        row("EXPIRE", -100, "SUCCEEDED", "e2e-bal-expire"),
        row("ADJUST", -100, "SUCCEEDED", "e2e-bal-adjust"),
        row("EARN", 999, "FAILED", "e2e-bal-failed"),
      ],
    });
  });
  await open(page);
  await expect(page.getByRole("heading", { name: "회원별 적립금 잔액" })).toBeVisible();
  const rows = page.getByTestId("balance-row");
  await expect(rows).toHaveCount(1);
  const r = rows.first();
  await expect(r).toContainText(NICK);
  // 현재 잔액 · 누적 적립(성공만, 실패 999 제외) · 사용 · 회수 · 소멸 · 조정(음수는 부호)
  await expect(r.locator("td").nth(1)).toHaveText("700원");
  await expect(r.locator("td").nth(2)).toHaveText("2,000원");
  await expect(r.locator("td").nth(3)).toHaveText("800원");
  await expect(r.locator("td").nth(4)).toHaveText("300원");
  await expect(r.locator("td").nth(5)).toHaveText("100원");
  await expect(r.locator("td").nth(6)).toHaveText("−100원");
  await expect(page.getByText("불러온", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /지급|회수 실행|조정/ })).toHaveCount(0);

  // 닉네임으로 찾기
  await page.getByLabel("방송 닉네임").fill("없는닉네임");
  const none = page.waitForResponse((x) => x.url().includes("/api/seller/reward-balances?") && x.url().includes("q="));
  await page.getByRole("button", { name: "검색" }).click();
  expect((await none).status()).toBe(200);
  await expect(page.getByText("조건에 맞는 회원이 없습니다")).toBeVisible();
  await page.getByLabel("방송 닉네임").fill("별빛");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(rows).toHaveCount(1);
});

test("잔액이 없으면 안내하고, 20명을 넘으면 「더 보기」로 이어서 불러온다", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByText("아직 적립금 잔액이 있는 회원이 없습니다")).toBeVisible();

  // 다음 쪽 커서가 오는 응답으로 「더 보기」 흐름을 확인한다(서버 쪽 커서 시험은 통합 시험이 맡는다)
  const item = (i: number) => ({
    member: { id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, broadcastNickname: `회원${i}` },
    balance: 100 + i, totalEarned: 200 + i, totalUsed: 0, totalRevoked: 0, totalExpired: 0, totalAdjusted: 0,
    updatedAt: new Date(Date.now() - i * 60_000).toISOString(),
  });
  await page.route("**/api/seller/reward-balances?*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const body = cursor ? { balances: [item(21), item(22)], nextCursor: null } : { balances: Array.from({ length: 20 }, (_, i) => item(i + 1)), nextCursor: "next-cursor" };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.reload();
  const rows = page.getByTestId("balance-row");
  await expect(rows).toHaveCount(20);
  await page.getByRole("button", { name: "더 보기" }).click();
  await expect(rows).toHaveCount(22);
  await expect(page.getByRole("button", { name: "더 보기" })).toHaveCount(0);
});

test("회원·적립금 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Frewards%2Fbalances");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/rewards\/balances$/);
  await expect(page.getByText("필요한 권한: 회원·적립금", { exact: false })).toBeVisible();
  await expect(page.getByTestId("balance-row")).toHaveCount(0);
});
