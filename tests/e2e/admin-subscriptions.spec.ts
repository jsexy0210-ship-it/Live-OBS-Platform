import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
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
  await rows.filter({ hasText: names.paid }).getByRole("link", { name: names.paid }).click();
  await expect(page).toHaveURL(/\/admin\/partners\/[0-9a-f-]{36}$/);
});
