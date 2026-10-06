import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-033 회원별 잔액: 닉네임 검색·누적 값·「더 보기」, 수동 조정(확인 창 → 지급·회수, 사유 필수).
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

test("잔액: 현재 잔액과 성공 내역 누적(지급·사용)이 보이고, 닉네임으로 찾을 수 있다", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "회원별 잔액" })).toBeVisible();
  const rows = page.getByTestId("balance-row");
  await expect(rows).toHaveCount(1);
  const r = rows.first();
  await expect(r).toContainText(NICK);
  // 잔액 · 누적 지급(성공만, 실패 999 제외) · 누적 사용 · 소멸 예정(없으면 —)
  await expect(r.locator("td").nth(2)).toHaveText("700원");
  await expect(r.locator("td").nth(3)).toHaveText("2,000원");
  await expect(r.locator("td").nth(4)).toHaveText("800원");
  await expect(r.locator("td").nth(5)).toHaveText("—");
  await expect(page.getByTestId("balances-summary")).toContainText("1명 · 합계 잔액 700원");
  await shot(page, "SA-033");

  // 닉네임으로 찾기
  await page.getByLabel("검색어").fill("없는닉네임");
  const none = page.waitForResponse((x) => x.url().includes("/api/seller/reward-balances?") && x.url().includes("q="));
  await page.getByRole("button", { name: "검색" }).click();
  expect((await none).status()).toBe(200);
  await expect(page.getByText("「없는닉네임」 결과가 없습니다")).toBeVisible();
  await page.getByLabel("검색어").fill("별빛");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(rows).toHaveCount(1);
});

test("잔액이 없으면 안내하고, 20명을 넘으면 「더 보기」로 이어서 불러온다", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByText("잔액이 있는 회원이 없습니다")).toBeVisible();

  // 다음 쪽 커서가 오는 응답으로 「더 보기」 흐름을 확인한다(서버 쪽 커서 시험은 통합 시험이 맡는다)
  const item = (i: number) => ({
    member: { id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, broadcastNickname: `회원${i}` },
    grade: { id: "00000000-0000-4000-8000-0000000000aa", name: "일반" },
    balance: 100 + i, totalEarned: 200 + i, totalUsed: 0, expiry: null, pendingCount: 0,
    updatedAt: new Date(Date.now() - i * 60_000).toISOString(),
  });
  await page.route("**/api/seller/reward-balances?*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const summary = { count: 22, totalBalance: 5000 };
    const pending = { count: 0, amount: 0 };
    const body = cursor ? { balances: [item(21), item(22)], summary, pending, nextCursor: null } : { balances: Array.from({ length: 20 }, (_, i) => item(i + 1)), summary, pending, nextCursor: "next-cursor" };
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

test("수동 조정: 회수는 잔액을 넘을 수 없고, 지급은 확인 창을 거쳐 대기(실제 지급 꺼짐) 또는 즉시 반영(켜짐)으로 남는다", async ({ page }) => {
  await reset();
  await withDb((db, sellerId, buyerMemberId) => db.rewardBalance.create({ data: { sellerId, buyerMemberId, balance: 700 } }));
  const setLive = (on: boolean) => withDb((db, sellerId) => db.rewardPolicy.upsert({ where: { sellerId }, create: { sellerId, livePayoutEnabled: on }, update: { livePayoutEnabled: on } }));
  await setLive(false);
  try {
    await open(page);
    const row = page.getByTestId("balance-row").first();
    await row.getByRole("button", { name: /적립금 조정/ }).click();
    const modal = page.getByRole("dialog", { name: `수동 조정 · ${NICK}` });
    await expect(modal.getByTestId("adjust-balance")).toHaveText("700원");

    // 입력 오류: 금액·잔액 초과 회수·사유
    await modal.getByRole("button", { name: "적용" }).click();
    await expect(modal.getByRole("alert")).toContainText("금액은 1원 이상 입력해 주십시오");
    await modal.getByRole("radio", { name: "회수" }).check();
    await modal.getByLabel("조정 금액").fill("800");
    await modal.getByRole("button", { name: "적용" }).click();
    await expect(modal.getByRole("alert")).toContainText("회수할 금액이 회원 잔액보다 많습니다");
    await modal.getByRole("radio", { name: "지급" }).check();
    await modal.getByLabel("조정 금액").fill("5000");
    await modal.getByRole("button", { name: "적용" }).click();
    await expect(modal.getByRole("alert")).toContainText("사유를 입력해 주십시오");
    await expect(modal.getByTestId("adjust-after")).toContainText("5,700원");
    await shot(page, "SA-033-adjust");

    // 실제 지급 꺼짐: 대기로 기록되고 잔액은 그대로
    await modal.getByLabel("사유").fill("이벤트 보상");
    await modal.getByRole("button", { name: "적용" }).click();
    const ask = page.getByRole("dialog", { name: "적립금 잔액을 조정하시겠습니까?" });
    await expect(ask).toContainText(`${NICK} · +5,000원 · 사유: 이벤트 보상`);
    await expect(ask).toContainText("「대기」로 기록되고 잔액은 그대로");
    const posted = page.waitForRequest((r) => r.url().includes("/adjust") && r.method() === "POST");
    await ask.getByRole("button", { name: "조정" }).click();
    expect((await posted).postDataJSON()).toMatchObject({ direction: "GRANT", amount: 5000, reason: "이벤트 보상" });
    await expect(page.getByText(`${NICK} +5,000원 대기로 기록`, { exact: false })).toBeVisible();
    await expect(page.getByTestId("balance-row").first().locator("td").nth(2)).toHaveText("700원");

    // 실제 지급 켜짐: 즉시 반영
    await setLive(true);
    await page.reload();
    await page.getByTestId("balance-row").first().getByRole("button", { name: /적립금 조정/ }).click();
    const modal2 = page.getByRole("dialog", { name: `수동 조정 · ${NICK}` });
    await modal2.getByLabel("조정 금액").fill("1000");
    await modal2.getByLabel("사유").fill("정정");
    await modal2.getByRole("button", { name: "적용" }).click();
    await page.getByRole("dialog", { name: "적립금 잔액을 조정하시겠습니까?" }).getByRole("button", { name: "조정" }).click();
    await expect(page.getByText(`${NICK} +1,000원 지급 · 잔액 1,700원 · 원장에 기록`)).toBeVisible();
    await expect(page.getByTestId("balance-row").first().locator("td").nth(2)).toHaveText("1,700원");
  } finally {
    await setLive(false);
  }
});
