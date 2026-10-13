import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-032 지급·회수 원장: 요약 카드·기간(기본 최근 1개월)·상태·유형·검색어, 부호 있는 금액·잔액(후), 실패 재시도, 「더 보기」(20건씩).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const NICK = "별빛사냥꾼";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

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

// 원장과 적립 정책을 처음 상태(정책 없음 = 실제 지급 꺼짐)로 돌린다. 다른 시험(적립금 쓰는 주문·실제 지급)이 정책을 켜 둔 채 끝나도
// 이 시험의 「꺼짐 안내·재시도 잠김」 전제가 깨지지 않게 하고, 이 시험이 켠 정책도 남기지 않는다.
async function reset() {
  await withDb(async (db, sellerId) => {
    await db.rewardLedger.deleteMany({ where: { sellerId } });
    await db.rewardPolicy.deleteMany({ where: { sellerId } });
  });
}

async function open(page: Page) {
  await page.goto("/seller/login?next=%2Fseller%2Frewards%2Fledger");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/rewards\/ledger$/);
}

test.afterAll(reset);

test("원장: 적립·회수(음수)·실패 사유가 최근 순으로 보이고, 상태로 찾을 수 있다. 요약 카드와 실제 지급 꺼짐 안내가 보인다", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "지급 · 회수 원장" })).toBeVisible();
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
  // 요약 카드(쇼핑몰 전체 기준)와, 정책이 없으면 실제 지급 꺼짐 안내
  await expect(page.getByTestId("sum-failed")).toHaveText("1건 · 300원");
  await expect(page.getByTestId("ledger-live-off")).toContainText("실제 지급 꺼짐");
  await expect(page.getByTestId("ledger-live-off").getByRole("link", { name: "실제 지급 켜기" })).toHaveAttribute("href", "/seller/rewards/live-payout");
  // 잔액(후): 성공 줄은 그 줄까지의 잔액, 아닌 줄은 「—」
  await expect(rows.nth(0)).toContainText("—");
  await expect(rows.nth(2)).toContainText("1,200원");

  await shot(page, "SA-032");

  // 상태로 찾기
  await page.getByLabel("상태", { exact: true }).selectOption("FAILED");
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
  // 업무 큐 링크(period=all)는 기간 제한 없이 조회한다
  const all = page.waitForResponse((r) => r.url().includes("/api/seller/reward-ledger?"));
  await page.goto("/seller/rewards/ledger?period=all");
  const allUrl = new URL((await all).url());
  expect(allUrl.searchParams.get("from")).toBe("");
  expect(allUrl.searchParams.get("to")).toBe("");
  await expect(rows).toHaveCount(2);
});

test("내역이 없으면 안내하고, 20건을 넘으면 「더 보기」로 이어서 불러온다", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByText("아직 적립 기록이 없습니다")).toBeVisible();

  // 다음 쪽 커서가 오는 응답으로 「더 보기」 흐름을 확인한다(서버 쪽 커서 시험은 통합 시험이 맡는다)
  const entry = (i: number) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    member: { id: "00000000-0000-4000-8000-000000000999", broadcastNickname: `회원${i}` },
    kind: "EARN_DELIVERY",
    amount: 100 + i,
    status: "SUCCEEDED",
    failureReason: null,
    reason: null,
    balanceAfter: 100 + i,
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

test("유형·검색어로 찾고, 엑셀 링크에 지금 조건이 실린다", async ({ page }) => {
  await reset();
  const now = Date.now();
  await withDb((db, sellerId, buyerMemberId) =>
    db.rewardLedger.createMany({
      data: [
        { sellerId, buyerMemberId, type: "EARN", amount: 1200, status: "SUCCEEDED", testMode: false, idempotencyKey: "e2e-k-earn", createdAt: new Date(now - 3 * 3_600_000), processedAt: new Date(now - 3 * 3_600_000) },
        { sellerId, buyerMemberId, type: "ADJUST", amount: 700, status: "SUCCEEDED", testMode: false, reason: "이벤트 보상", idempotencyKey: "e2e-k-adjust", createdAt: new Date(now - 2 * 3_600_000), processedAt: new Date(now - 2 * 3_600_000) },
      ],
    }),
  );
  await open(page);
  const rows = page.getByTestId("ledger-row");
  await expect(rows).toHaveCount(2);

  await page.getByLabel("유형", { exact: true }).selectOption("ADJUST_GRANT");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("수동 지급");
  await expect(rows.first()).toContainText("이벤트 보상");
  await expect(page.getByRole("link", { name: "엑셀 내려받기" })).toHaveAttribute("href", /\/api\/seller\/reward-ledger\/export\?.*kind=ADJUST_GRANT/);

  await page.getByRole("button", { name: "초기화" }).click();
  await expect(rows).toHaveCount(2);
  await page.getByLabel("검색어").fill("없는닉네임");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByText("조건에 맞는 내역이 없습니다")).toBeVisible();
  await page.getByLabel("검색어").fill("별빛");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(rows).toHaveCount(2);
});

test("실패 재시도: 확인 창을 거치고 결과를 건수로 알린다(실제 지급이 꺼져 있으면 누를 수 없다)", async ({ page }) => {
  await reset();
  await withDb((db, sellerId, buyerMemberId) =>
    db.rewardLedger.create({ data: { sellerId, buyerMemberId, type: "REVOKE", amount: -1350, status: "FAILED", testMode: false, failureReason: "잔액 부족", idempotencyKey: "e2e-retry", createdAt: new Date(Date.now() - 3_600_000) } }),
  );
  await open(page);
  // 정책이 없거나 실제 지급이 꺼져 있으면 재시도 버튼이 잠긴다
  await expect(page.getByRole("button", { name: "실패 1건 재시도" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /지급 재시도$/ })).toBeDisabled();

  await withDb((db, sellerId) => db.rewardPolicy.upsert({ where: { sellerId }, create: { sellerId, livePayoutEnabled: true }, update: { livePayoutEnabled: true } }));
  try {
    await page.route("**/api/seller/reward-ledger/retry", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requested: 1, result: { settled: 0, failed: 1, skipped: null } }) }));
    await page.reload();
    await expect(page.getByTestId("ledger-live-off")).toHaveCount(0);
    await page.getByRole("button", { name: "실패 1건 재시도" }).click();
    const dialog = page.getByRole("dialog", { name: "실패 1건을 다시 시도하시겠습니까?" });
    await expect(dialog).toContainText("잔액이 모자라 실패한 회수는 다시 실패로 남을 수 있습니다");
    const posted = page.waitForRequest((r) => r.url().endsWith("/api/seller/reward-ledger/retry") && r.method() === "POST");
    await dialog.getByRole("button", { name: "다시 시도" }).click();
    expect((await posted).postDataJSON()).toEqual({});
    await expect(page.getByText("실패 1건 중 0건 성공 · 1건 다시 실패")).toBeVisible();
  } finally {
    await withDb((db, sellerId) => db.rewardPolicy.updateMany({ where: { sellerId }, data: { livePayoutEnabled: false } }));
  }
});
