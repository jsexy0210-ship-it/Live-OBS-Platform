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

test("잔액이 없으면 안내하고, 10명을 넘으면 페이지 이동으로 다음 쪽 커서를 이어서 불러온다", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByText("잔액이 있는 회원이 없습니다")).toBeVisible();

  // 쪽마다 10명과 다음 쪽 커서가 오는 응답으로 페이지 이동 흐름을 확인한다(서버 쪽 커서 시험은 통합 시험이 맡는다)
  const item = (i: number) => ({
    member: { id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, broadcastNickname: `회원${i}` },
    grade: { id: "00000000-0000-4000-8000-0000000000aa", name: "일반" },
    balance: 100 + i, totalEarned: 200 + i, totalUsed: 0, expiry: null, pendingCount: 0,
    updatedAt: new Date(Date.now() - i * 60_000).toISOString(),
  });
  const pages: Record<string, { from: number; to: number; next: string | null }> = {
    first: { from: 1, to: 10, next: "cursor-2" },
    "cursor-2": { from: 11, to: 20, next: "cursor-3" },
    "cursor-3": { from: 21, to: 22, next: null },
  };
  await page.route("**/api/seller/reward-balances?*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const spec = pages[cursor ?? "first"];
    const summary = { count: 22, totalBalance: 5000 };
    const pending = { count: 0, amount: 0 };
    const balances = Array.from({ length: spec.to - spec.from + 1 }, (_, i) => item(spec.from + i));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balances, summary, pending, nextCursor: spec.next }) });
  });
  await page.reload();
  const rows = page.getByTestId("balance-row");
  const nav = page.getByRole("navigation", { name: "페이지 이동", exact: true });
  await expect(rows).toHaveCount(10);
  await expect(nav.getByRole("button", { name: "1페이지", exact: true })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("button", { name: "다음", exact: true }).click();
  await expect(rows).toHaveCount(10);
  await expect(nav.getByRole("button", { name: "2페이지", exact: true })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("button", { name: "다음", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(nav.getByRole("button", { name: "3페이지", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
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

test("조정 결과를 잃고 창을 다시 열어도 같은 요청은 한 번만 반영하고, 성공 후에는 새 요청으로 보낸다", async ({ page }) => {
  await reset();
  await withDb(async (db, sellerId, buyerMemberId) => {
    await db.rewardBalance.create({ data: { sellerId, buyerMemberId, balance: 700 } });
    await db.rewardPolicy.upsert({ where: { sellerId }, create: { sellerId, livePayoutEnabled: true }, update: { livePayoutEnabled: true } });
  });
  const sent: { requestId: string; direction: string; amount: number; reason: string }[] = [];
  const replies: { replayed: boolean; balanceAfter: number }[] = [];
  await page.route("**/api/seller/reward-balances/*/adjust", async (route) => {
    sent.push(route.request().postDataJSON());
    // 다른 내용의 실패도 원래 요청의 재시도 키를 지우지 않아야 한다.
    if (sent.length === 2) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) });
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    replies.push(await response.json());
    // 서버는 반영했지만 브라우저는 결과를 받지 못한 상황.
    if (sent.length === 1) return route.abort("failed");
    return route.fulfill({ response });
  });
  try {
    await open(page);
    const row = page.getByTestId("balance-row").first();
    await row.getByRole("button", { name: /적립금 조정/ }).click();
    const modal = page.getByRole("dialog", { name: `수동 조정 · ${NICK}` });
    const ask = page.getByRole("dialog", { name: "적립금 잔액을 조정하시겠습니까?" });
    await modal.getByLabel("조정 금액").fill("1,000");
    await modal.getByLabel("사유").fill(" 재시도 ");
    await modal.getByRole("button", { name: "적용" }).click();
    await ask.getByRole("button", { name: "조정", exact: true }).click();
    await expect(ask.getByRole("alert")).toBeVisible();
    await ask.getByRole("button", { name: "취소", exact: true }).click();
    await modal.getByRole("button", { name: "취소", exact: true }).click();
    await modal.locator(".modal-confirm").getByRole("button", { name: "닫기", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await page.goto("/seller/rewards/ledger");
    await page.goto("/seller/rewards/balances");
    await page.reload();

    await row.getByRole("button", { name: /적립금 조정/ }).click();
    await modal.getByLabel("조정 금액").fill("1000");
    await modal.getByLabel("사유").fill("다른 사유");
    await modal.getByRole("button", { name: "적용" }).click();
    await ask.getByRole("button", { name: "조정", exact: true }).click();
    await expect(ask.getByRole("alert")).toBeVisible();
    await ask.getByRole("button", { name: "취소", exact: true }).click();
    expect(sent[1].requestId).not.toBe(sent[0].requestId);

    await modal.getByLabel("사유").fill("재시도");
    await modal.getByRole("button", { name: "적용" }).click();
    await expect(modal.getByRole("link", { name: "원장 확인", exact: true })).toHaveAttribute("href", "/seller/rewards/ledger");
    await modal.getByRole("button", { name: "이전 요청 재시도", exact: true }).click();
    await page.getByRole("dialog", { name: "이전 요청을 다시 보낼까요?" }).getByRole("button", { name: "이전 요청 재시도", exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(sent[2]).toEqual(sent[0]);
    expect(sent[0]).toMatchObject({ direction: "GRANT", amount: 1000, reason: "재시도" });
    expect(replies[1]).toMatchObject({ replayed: true, balanceAfter: 1700 });
    expect(await withDb((db, sellerId) => db.rewardLedger.count({ where: { sellerId, type: "ADJUST" } }))).toBe(1);
    await expect(row.locator("td").nth(2)).toHaveText("1,700원");

    await row.getByRole("button", { name: /적립금 조정/ }).click();
    await modal.getByLabel("조정 금액").fill("1000");
    await modal.getByLabel("사유").fill("재시도");
    await modal.getByRole("button", { name: "적용" }).click();
    await ask.getByRole("button", { name: "조정", exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(sent[3].requestId).not.toBe(sent[0].requestId);
    expect(sent[3].requestId).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    expect(replies[2]).toMatchObject({ replayed: false, balanceAfter: 2700 });
    expect(await withDb((db, sellerId) => db.rewardLedger.count({ where: { sellerId, type: "ADJUST" } }))).toBe(2);
    await expect(row.locator("td").nth(2)).toHaveText("2,700원");
  } finally {
    await withDb((db, sellerId) => db.rewardPolicy.update({ where: { sellerId }, data: { livePayoutEnabled: false } }));
  }
});

test("결과 미확인 요청이 있어도 중복 가능성을 확인한 새 조정은 별도 UUID로 보내고 원래 요청을 보존한다", async ({ page }) => {
  await reset();
  await withDb(async (db, sellerId, buyerMemberId) => {
    await db.rewardBalance.create({ data: { sellerId, buyerMemberId, balance: 700 } });
    await db.rewardPolicy.upsert({ where: { sellerId }, create: { sellerId, livePayoutEnabled: true }, update: { livePayoutEnabled: true } });
  });
  const ids: string[] = [];
  await page.route("**/api/seller/reward-balances/*/adjust", async (route) => {
    ids.push(route.request().postDataJSON().requestId);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (ids.length === 1) return route.abort("failed");
    return route.fulfill({ response });
  });
  try {
    await open(page);
    const row = page.getByTestId("balance-row").first();
    const modal = page.getByRole("dialog", { name: `수동 조정 · ${NICK}` });
    await row.getByRole("button", { name: /적립금 조정/ }).click();
    await modal.getByLabel("조정 금액").fill("1000");
    await modal.getByLabel("사유").fill("결과 미확인");
    await modal.getByRole("button", { name: "적용" }).click();
    const ask = page.getByRole("dialog", { name: "적립금 잔액을 조정하시겠습니까?" });
    await ask.getByRole("button", { name: "조정", exact: true }).click();
    await expect(ask.getByRole("alert")).toBeVisible();
    await page.reload();
    await row.getByRole("button", { name: /적립금 조정/ }).click();
    await modal.getByLabel("조정 금액").fill("1000");
    await modal.getByLabel("사유").fill("결과 미확인");
    await modal.getByRole("button", { name: "적용" }).click();
    await modal.getByRole("button", { name: "새 조정", exact: true }).click();
    const newAsk = page.getByRole("dialog", { name: "새 조정을 보낼까요?" });
    await expect(newAsk).toContainText("이전 요청이 이미 반영됐다면 같은 금액이 한 번 더 조정될 수 있어요.");
    await newAsk.getByRole("button", { name: "취소", exact: true }).click();
    expect(ids).toHaveLength(1);
    await modal.getByRole("button", { name: "새 조정", exact: true }).click();
    await newAsk.getByRole("button", { name: "새 조정", exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(await withDb((db, sellerId) => db.rewardLedger.count({ where: { sellerId, type: "ADJUST" } }))).toBe(2);
    await expect(row.locator("td").nth(2)).toHaveText("2,700원");
    const pending = await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("onq:reward-adjust:")).flatMap((key) => JSON.parse(sessionStorage.getItem(key)!)));
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(ids[0]);
    expect(Object.keys(pending[0]).sort()).toEqual(["id", "intent"]);
    expect(pending[0].intent).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await withDb((db, sellerId) => db.rewardPolicy.update({ where: { sellerId }, data: { livePayoutEnabled: false } }));
  }
});

test("다른 파트너스·사용자의 미확정 요청은 표시하지 않고 보관 실패는 POST 전에 막는다", async ({ page }) => {
  await reset();
  const memberId = await withDb(async (db, sellerId, buyerMemberId) => {
    await db.rewardBalance.create({ data: { sellerId, buyerMemberId, balance: 700 } });
    return buyerMemberId;
  });
  await open(page);
  const actualMe = await (await page.request.get("/api/seller/me")).json();
  const key = await page.evaluate(async ({ sellerId, userId, memberId }) => {
    const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (n) => n.toString(16).padStart(2, "0")).join("");
    const key = `onq:reward-adjust:${await hash(JSON.stringify([sellerId, userId]))}`;
    sessionStorage.setItem(key, JSON.stringify([{ id: crypto.randomUUID(), intent: await hash(JSON.stringify([memberId, "GRANT", 1000, "범위 확인"])) }]));
    return key;
  }, { sellerId: actualMe.sellerId, userId: actualMe.userId, memberId });
  let viewMe = actualMe;
  await page.route("**/api/seller/me", (route) => route.fulfill({ json: viewMe }));
  const posts: string[] = [];
  await page.route("**/api/seller/reward-balances/*/adjust", (route) => {
    posts.push(route.request().method());
    return route.fulfill({ status: 500, json: { error: "unexpected_post" } });
  });
  for (const other of [{ ...actualMe, sellerId: "different-seller" }, { ...actualMe, userId: "different-user" }]) {
    viewMe = other;
    await page.reload();
    await page.getByTestId("balance-row").first().getByRole("button", { name: /적립금 조정/ }).click();
    const modal = page.getByRole("dialog", { name: `수동 조정 · ${NICK}` });
    await modal.getByLabel("조정 금액").fill("1000");
    await modal.getByLabel("사유").fill("범위 확인");
    await modal.getByRole("button", { name: "적용" }).click();
    await expect(page.getByRole("dialog", { name: "적립금 잔액을 조정하시겠습니까?" })).toBeVisible();
    await expect(modal.getByLabel("재시도할 이전 요청")).toHaveCount(0);
  }
  viewMe = actualMe;
  await page.reload();
  await page.evaluate((key) => sessionStorage.setItem(key, "broken"), key);
  const row = page.getByTestId("balance-row").first();
  await row.getByRole("button", { name: /적립금 조정/ }).click();
  const modal = page.getByRole("dialog", { name: `수동 조정 · ${NICK}` });
  await modal.getByLabel("조정 금액").fill("1000");
  await modal.getByLabel("사유").fill("범위 확인");
  await modal.getByRole("button", { name: "적용" }).click();
  await expect(modal.getByRole("alert")).toContainText("재시도 정보를 보관하지 못했어요");
  expect(posts).toEqual([]);
  await page.evaluate((key) => sessionStorage.removeItem(key), key);
  await modal.getByRole("button", { name: "적용" }).click();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("storage blocked", "SecurityError"); }; });
  const ask = page.getByRole("dialog", { name: "적립금 잔액을 조정하시겠습니까?" });
  await ask.getByRole("button", { name: "조정", exact: true }).click();
  await expect(ask.getByRole("alert")).toContainText("재시도 정보를 보관하지 못했어요");
  expect(posts).toEqual([]);
});
