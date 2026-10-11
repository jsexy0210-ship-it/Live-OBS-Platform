import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 구독 현황(MA-023). 계정·파트너스·구독은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
// 이용 상태 탭(체험·이용 중·연체·해지)별로 맞는 파트너스만 보이는지, 검색·요금제 필터, CS도 조회할 수 있는지 확인한다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const cs = `sub-cs-${run}@example.com`;
const names = { trial: `체험몰 ${run}`, paid: `이용몰 ${run}`, grace: `연체몰 ${run}`, expired: `해지몰 ${run}` };
const DAY = 86_400_000;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email: cs, passwordHash: await hashPassword(password), name: "상담", role: "CS" } });
  const plan = await db.subscriptionPlan.findFirstOrThrow({ where: { code: "INTEGRATED" } });
  const now = Date.now();
  const make = (key: keyof typeof names, trialDays: number | null) =>
    db.seller.create({
      data: { slug: `sub${key}-${run}`, shopName: names[key], status: "ACTIVE", approvedAt: new Date(now - 40 * DAY), planId: plan.id, trialEndsAt: trialDays == null ? null : new Date(now + trialDays * DAY) },
    });
  await make("trial", 5);
  const paid = await make("paid", null);
  const grace = await make("grace", null);
  await make("expired", null);
  await db.sellerSubscription.create({
    data: { sellerId: paid.id, planId: plan.id, status: "ACTIVE", cardLabel: "시험카드 1234", currentPeriodStart: new Date(now - 5 * DAY), currentPeriodEnd: new Date(now + 25 * DAY), nextChargeAt: new Date(now + 25 * DAY) },
  });
  await db.sellerSubscription.create({
    data: {
      sellerId: grace.id,
      planId: plan.id,
      status: "PAST_DUE",
      cardLabel: "연체카드 9999",
      currentPeriodStart: new Date(now - 35 * DAY),
      currentPeriodEnd: new Date(now - 5 * DAY),
      graceUntil: new Date(now + 2 * DAY),
      retryCount: 2,
      nextChargeAt: new Date(now + DAY),
    },
  });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(cs);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/billing/subscriptions");
  await page.getByLabel("쇼핑몰 이름 · 주소").fill(run);
  await page.getByRole("button", { name: "검색", exact: true }).click();
}

test("CS도 구독 현황을 조회한다: 탭별로 맞는 파트너스만 보이고, 표 데이터는 가운데 정렬이며, 요금제 필터와 초기화가 된다", async ({ page }) => {
  await open(page);
  const mutations: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/admin/subscriptions") && !["GET", "HEAD"].includes(r.method())) mutations.push(r.method()); });
  const rows = page.getByTestId("subscription-row");
  await expect(rows).toHaveCount(4);
  const tab = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) });
  const expectOnly = async (label: string, key: keyof typeof names) => {
    await tab(label).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(names[key]);
  };
  await expectOnly("체험", "trial");
  await expectOnly("이용 중", "paid");
  await expect(rows).toContainText("시험카드 1234");
  await expectOnly("연체", "grace");
  await expect(rows).toContainText("결제 2번 다시 시도");
  await expectOnly("해지", "expired");
  await expect(rows).toContainText("구독 없음");
  await tab("전체").click();
  await expect(rows).toHaveCount(4);
  const align = await page.locator(".tbl td").first().evaluate((el) => getComputedStyle(el).textAlign);
  expect(align).toBe("center"); // 표 정렬 새 규칙(2026-10-05): 글 열(.col-text)이 아니면 데이터는 가운데

  await page.getByLabel("요금제").selectOption("OVERLAY_ONLY");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("조건에 맞는 구독이 없습니다.")).toBeVisible();
  await page.getByRole("button", { name: "조건 초기화" }).first().click();
  await page.getByLabel("쇼핑몰 이름 · 주소").fill(run);
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(rows).toHaveCount(4);
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const evidence = `tests/e2e/screenshots/current-shell-${sourceSha}`;
  mkdirSync(evidence, { recursive: true });
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    let failure: { error: unknown } | undefined;
    let api: { subscriptions: { seller: { id: string; shopName: string; slug: string }; access: string }[] } | undefined;
    try {
      const response = await page.request.get(`/api/admin/subscriptions?limit=50&q=${encodeURIComponent(run)}`);
      expect(response.status()).toBe(200);
      api = await response.json();
      await expect(rows).toHaveCount(4);
      for (const name of Object.values(names)) await expect(rows.filter({ hasText: name })).toHaveCount(1);
      await page.locator("main .tbl").evaluate((el) => { if (el.parentElement) el.parentElement.scrollLeft = 0; });
      await page.evaluate(() => document.fonts.ready);
    } catch (error) { failure = { error }; }
    try {
      const metrics = await page.evaluate(() => {
        const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const table = document.querySelector("main .tbl"); const scroll = table?.parentElement;
        return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null }, height: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth > innerWidth,
          table: table ? { ...box(table), headers: Array.from(table.querySelectorAll("thead th")).map((el) => ({ text: el.textContent?.trim(), ...box(el) })) } : null,
          scroll: scroll ? { ...box(scroll), overflowX: getComputedStyle(scroll).overflowX, clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth, scrollLeft: scroll.scrollLeft } : null,
          rows: Array.from(document.querySelectorAll('[data-testid="subscription-row"]')).map((row) => ({ text: row.textContent?.trim(), ...box(row), cells: Array.from(row.querySelectorAll("td")).map((el) => ({ text: el.textContent?.trim(), align: getComputedStyle(el).textAlign, ...box(el) })), actions: Array.from(row.querySelectorAll("a,button")).map((el) => ({ text: el.textContent?.trim(), href: el.getAttribute("href"), ...box(el) })) })) };
      });
      await page.screenshot({ path: `${evidence}/MA-023-CS-${width}.png`, fullPage: true });
      writeFileSync(`${evidence}/MA-023-CS-${width}.json`, JSON.stringify({ sourceSha, route: new URL(page.url()).pathname, role: "CS", state: failure ? "not-ready" : "four-access-states", api, ...metrics }, null, 2));
      if (failure) throw failure.error;
      expect(api?.subscriptions).toHaveLength(4);
      expect(api?.subscriptions.map((r) => r.access).sort()).toEqual(["expired", "grace", "paid", "trial"]);
      expect(metrics.rows).toHaveLength(4); expect(metrics.table?.headers).toHaveLength(9);
      expect(metrics.overflow).toBe(false); expect(metrics.scroll?.overflowX).toBe("auto");
      if (!api) throw new Error("구독 조회 응답이 없습니다");
      for (const record of api.subscriptions) {
        const row = rows.filter({ hasText: record.seller.shopName });
        await expect(row.getByRole("link", { name: record.seller.shopName, exact: true })).toHaveAttribute("href", `/admin/partners/${record.seller.id}`);
        await expect(row).toContainText(`쇼핑몰 주소 ${record.seller.slug}`);
      }
      await page.locator("main .tbl").evaluate((el) => { if (el.parentElement) el.parentElement.scrollLeft = el.parentElement.scrollWidth; });
      const finalCell = rows.filter({ hasText: names.grace }).locator("td").last();
      await finalCell.scrollIntoViewIfNeeded();
      const access = await finalCell.evaluate((el) => { const r = el.getBoundingClientRect(); const container = el.closest("table")?.parentElement; const scroll = container?.getBoundingClientRect(); return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null }, text: el.textContent?.trim(), left: r.left, right: r.right, containerLeft: scroll?.left, containerRight: scroll?.right, scrollLeft: container?.scrollLeft }; });
      writeFileSync(`${evidence}/MA-023-CS-${width}-scroll.json`, JSON.stringify({ sourceSha, role: "CS", route: new URL(page.url()).pathname, state: "last-column", ...access }, null, 2));
      expect(access.text).toContain("결제 2번 다시 시도");
      expect(access.containerLeft).toBeDefined(); expect(access.containerRight).toBeDefined();
      expect(access.left).toBeGreaterThanOrEqual(access.containerLeft!); expect(access.right).toBeLessThanOrEqual(access.containerRight!);
    } catch (error) { throw failure ? failure.error : error; }
  }
  const paidLink = rows.filter({ hasText: names.paid }).getByRole("link", { name: names.paid });
  await paidLink.focus(); await expect(paidLink).toBeFocused();
  await rows.filter({ hasText: names.paid }).getByRole("link", { name: names.paid }).click();
  await expect(page).toHaveURL(/\/admin\/partners\/[0-9a-f-]{36}$/);
  expect(mutations).toEqual([]);
});
