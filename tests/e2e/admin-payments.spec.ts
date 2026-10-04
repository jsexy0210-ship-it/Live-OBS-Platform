import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 청구·결제 내역(MA-024)·청구 상세(MA-025). 계정·파트너스·청구는 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
// CS 계정으로 조회만 한다(결제 실행·환불 버튼이 없어야 한다).
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const cs = `pay-cs-${run}@example.com`;
const shopName = `청구몰 ${run}`;
const DAY = 86_400_000;
let db: PrismaClient;
let sellerId = "";
let paidId = "";
let failedId = "";

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email: cs, passwordHash: await hashPassword(password), name: "상담", role: "CS" } });
  const integrated = await db.subscriptionPlan.findFirstOrThrow({ where: { code: "INTEGRATED" } });
  const overlay = await db.subscriptionPlan.findFirstOrThrow({ where: { code: "OVERLAY_ONLY" } });
  const seller = await db.seller.create({ data: { slug: `pay-${run}`, shopName, status: "ACTIVE", approvedAt: new Date(), planId: integrated.id } });
  sellerId = seller.id;
  const sub = await db.sellerSubscription.create({ data: { sellerId, planId: integrated.id, cardLabel: "청구카드 4321", currentPeriodEnd: new Date(Date.now() + 10 * DAY) } });
  const now = Date.now();
  const base = { sellerId, subscriptionId: sub.id };
  const paid = await db.subscriptionPayment.create({
    data: { ...base, amount: 29_000, status: "PAID", periodStart: new Date(now - 20 * DAY), periodEnd: new Date(now + 10 * DAY), providerPaymentId: `pg-${run}`, receiptUrl: "https://example.com/receipt/1", paidAt: new Date(now - 20 * DAY), createdAt: new Date(now - 20 * DAY), launchDiscount: true, scheduled: true },
  });
  const failed = await db.subscriptionPayment.create({
    data: { ...base, amount: 29_000, status: "FAILED", periodStart: new Date(now - 50 * DAY), periodEnd: new Date(now - 20 * DAY), failureReason: "카드 한도 초과", createdAt: new Date(now - 50 * DAY) },
  });
  await db.subscriptionPayment.create({
    data: { ...base, amount: 5_000, status: "PENDING", kind: "PRORATION", targetPlanId: overlay.id, periodStart: new Date(now - 5 * DAY), periodEnd: new Date(now + 10 * DAY), createdAt: new Date(now - 5 * DAY) },
  });
  paidId = paid.id;
  failedId = failed.id;
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function open(page: Page, path: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(cs);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto(path);
}

test("CS도 청구·결제 내역을 조회한다: 파트너스 지정·상태·구분·기간 필터, 값은 왼쪽 정렬, 코드는 이름으로 보인다", async ({ page }) => {
  await open(page, `/admin/billing/invoices?sellerId=${sellerId}`);
  const rows = page.getByTestId("payment-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("차액 결제");
  await expect(rows.first()).toContainText("오버레이 전용");
  await expect(page.locator("main")).not.toContainText("OVERLAY_ONLY");
  await expect(page.getByRole("button", { name: /환불|결제 실행|재시도/ })).toHaveCount(0);
  const align = await page.locator(".tbl td").first().evaluate((el) => getComputedStyle(el).textAlign);
  expect(["left", "start"]).toContain(align);

  const search = () => page.getByRole("button", { name: "검색", exact: true }).click();
  await page.getByLabel("결제 상태").selectOption("FAILED");
  await search();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("결제 실패");
  await page.getByLabel("결제 상태").selectOption("");
  await page.getByLabel("구분").selectOption("PRORATION");
  await search();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("결제 대기");
  await page.getByLabel("구분").selectOption("");

  // 기간: 시작일이 종료일보다 늦으면 요청 없이 안내
  await page.getByLabel("청구 시작일").fill("2026-10-10");
  await page.getByLabel("청구 종료일").fill("2026-10-01");
  await search();
  await expect(page.locator(".err[role=alert]")).toHaveText("시작일이 종료일보다 늦습니다.");
  const kst = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(ms));
  await page.getByLabel("청구 시작일").fill(kst(Date.now() - 30 * DAY));
  await page.getByLabel("청구 종료일").fill(kst(Date.now()));
  await search();
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(rows).toHaveCount(3);
  await page.getByRole("button", { name: "전체 보기" }).click();
  await expect(page.getByRole("button", { name: "전체 보기" })).toHaveCount(0);
});

test("청구 상세: 결제 번호·카드 매출전표 링크·구독, 실패 청구는 실패 사유가 보인다", async ({ page }) => {
  await open(page, `/admin/billing/invoices/${paidId}`);
  await expect(page.getByRole("heading", { name: "29,000원 · 결제 완료", level: 1 })).toBeVisible();
  await expect(page.getByText(`pg-${run}`)).toBeVisible();
  const receipt = page.getByRole("link", { name: "매출전표 보기" });
  await expect(receipt).toHaveAttribute("href", "https://example.com/receipt/1");
  await expect(receipt).toHaveAttribute("rel", /noopener/);
  await expect(page.getByText("청구카드 4321")).toBeVisible();
  await expect(page.getByText("적용", { exact: true })).toBeVisible();
  await expect(page.locator(".loc-bar .crumb")).toContainText("청구 상세");
  await page.getByRole("link", { name: shopName }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/partners/${sellerId}$`));
  await page.getByRole("link", { name: "청구·결제 내역" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/billing/invoices\\?sellerId=${sellerId}`));

  await page.goto(`/admin/billing/invoices/${failedId}`);
  await expect(page.getByText("카드 한도 초과")).toBeVisible();
  await page.goto("/admin/billing/invoices/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("청구 내역을 찾을 수 없습니다.")).toBeVisible();
});
