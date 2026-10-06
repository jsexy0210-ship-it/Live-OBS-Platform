import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-032 적립금 지급·회수 내역: 조회만(GET /api/seller/reward-ledger). 기간(기본 최근 1개월)·처리 상태 검색, 부호 있는 금액, 「더 보기」(20건씩).
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
  await withDb((db, sellerId) => db.rewardLedger.deleteMany({ where: { sellerId } }));
}

async function open(page: Page) {
  await page.goto("/seller/login?next=%2Fseller%2Frewards%2Fledger");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/rewards\/ledger$/);
}

test.afterAll(reset);

test("내역: 적립·회수(음수)·실패 사유가 최근 순으로 보이고, 처리 상태로 찾을 수 있다. 지급·회수 버튼은 없다", async ({ page }) => {
  await reset();
  const now = Date.now();
  await withDb((db, sellerId, buyerMemberId) =>
    db.rewardLedger.createMany({
      data: [
        { sellerId, buyerMemberId, type: "EARN", amount: 1200, status: "SUCCEEDED", testMode: false, idempotencyKey: "e2e-earn", createdAt: new Date(now - 3 * 3_600_000), processedAt: new Date(now - 3 * 3_600_000) },
        { sellerId, buyerMemberId, type: "REVOKE", amount: -500, status: "SUCCEEDED", testMode: true, idempotencyKey: "e2e-revoke", createdAt: new Date(now - 2 * 3_600_000), processedAt: new Date(now - 2 * 3_600_000) },
        { sellerId, buyerMemberId, type: "EARN", amount: 300, status: "FAILED", testMode: false, failureReason: "지급 처리 실패", idempotencyKey: "e2e-failed", createdAt: new Date(now - 1 * 3_600_000) },
      ],
    }),
  );
  await open(page);
  await expect(page.getByRole("heading", { name: "적립금 지급·회수 내역" })).toBeVisible();
  const rows = page.getByTestId("ledger-row");
  await expect(rows).toHaveCount(3);
  // 최근 순: 실패(300) → 회수(−500, 계산만) → 적립(1,200)
  await expect(rows.nth(0)).toContainText("실패");
  await expect(rows.nth(0)).toContainText("지급 처리 실패");
  await expect(rows.nth(1)).toContainText("회수 · 계산만");
  await expect(rows.nth(1)).toContainText("−500원");
  await expect(rows.nth(2)).toContainText("+1,200원");
  await expect(rows.nth(2)).toContainText(NICK);
  // 일시는 공용 서식 「2026.10.05 22:25」
  await expect(rows.nth(2)).toContainText(/\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}/);
  await expect(page.getByText("불러온", { exact: false }).first()).toBeVisible();
  // 조회만: 지급·회수 실행 버튼이 없다
  await expect(page.getByRole("button", { name: /지급|회수 실행/ })).toHaveCount(0);

  // 처리 상태로 찾기
  await page.getByLabel("처리 상태").selectOption("FAILED");
  const res = page.waitForResponse((r) => r.url().includes("/api/seller/reward-ledger?") && r.url().includes("status=FAILED"));
  await page.getByRole("button", { name: "검색" }).click();
  expect((await res).status()).toBe(200);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("지급 처리 실패");
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(rows).toHaveCount(3);
});

test("기간: 기본은 최근 1개월이라 오래된 내역은 안 보이고, 기간을 넓히면 보인다(요청에 from·to가 실린다)", async ({ page }) => {
  await reset();
  const day = 86_400_000;
  await withDb((db, sellerId, buyerMemberId) =>
    db.rewardLedger.createMany({
      data: [
        { sellerId, buyerMemberId, type: "EARN", amount: 111, status: "SUCCEEDED", testMode: false, idempotencyKey: "e2e-recent", createdAt: new Date(Date.now() - 2 * day), processedAt: new Date() },
        { sellerId, buyerMemberId, type: "EARN", amount: 222, status: "SUCCEEDED", testMode: false, idempotencyKey: "e2e-old", createdAt: new Date(Date.now() - 45 * day), processedAt: new Date() },
      ],
    }),
  );
  const first = page.waitForResponse((r) => r.url().includes("/api/seller/reward-ledger?"));
  await open(page);
  const url = new URL((await first).url());
  expect(url.searchParams.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(url.searchParams.get("to")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(url.searchParams.get("limit")).toBe("20");
  const rows = page.getByTestId("ledger-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("+111원");
  // 시작일을 60일 전으로(주소 조건) 열면 오래된 내역도 나온다
  const ymd = (offset: number) => new Date(Date.now() + 9 * 3_600_000 - offset * day).toISOString().slice(0, 10);
  await page.goto(`/seller/rewards/ledger?from=${ymd(60)}&to=${ymd(0)}`);
  await expect(rows).toHaveCount(2);
  await expect(page.getByText("+222원")).toBeVisible();
});

test("내역이 없으면 안내하고, 20건을 넘으면 「더 보기」로 이어서 불러온다", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByText("아직 적립금 내역이 없습니다")).toBeVisible();

  // 다음 쪽 커서가 오는 응답으로 「더 보기」 흐름을 확인한다(서버 쪽 커서 시험은 통합 시험이 맡는다)
  const entry = (i: number) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    member: { id: "00000000-0000-4000-8000-000000000999", broadcastNickname: `회원${i}` },
    type: "EARN",
    amount: 100 + i,
    status: "SUCCEEDED",
    failureReason: null,
    order: null,
    testMode: false,
    createdAt: new Date(Date.now() - i * 60_000).toISOString(),
    processedAt: null,
  });
  await page.route("**/api/seller/reward-ledger?*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const body = cursor ? { entries: [entry(21), entry(22)], nextCursor: null } : { entries: Array.from({ length: 20 }, (_, i) => entry(i + 1)), nextCursor: "next-cursor" };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.reload();
  const rows = page.getByTestId("ledger-row");
  await expect(rows).toHaveCount(20);
  await page.getByRole("button", { name: "더 보기" }).click();
  await expect(rows).toHaveCount(22);
  await expect(page.getByRole("button", { name: "더 보기" })).toHaveCount(0);
});

test("회원·적립금 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Frewards%2Fledger");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/rewards\/ledger$/);
  await expect(page.getByText("필요한 권한: 회원·적립금", { exact: false })).toBeVisible();
  await expect(page.getByTestId("ledger-row")).toHaveCount(0);
});
