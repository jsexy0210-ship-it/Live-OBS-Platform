import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 통합 대시보드(MA-001). CS 계정(조회 전용 역할)으로 로그인 직후 홈에서 숫자가 API 값과 같은지 확인한다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const cs = `dash-cs-${run}@example.com`;

test.beforeAll(async () => {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    await db.platformAdmin.create({ data: { email: cs, passwordHash: await hashPassword(password), name: "상담", role: "CS" } });
    await db.seller.create({ data: { slug: `dash-${run}`, shopName: `대시몰 ${run}`, status: "SUSPENDED", approvedAt: new Date(), suspendedReason: "시험" } });
  } finally {
    await db.$disconnect();
  }
});

test("로그인하면 홈에 통합 대시보드가 보이고, 숫자가 API 값과 같으며, 목록 화면으로 이어진다", async ({ page }) => {
  const protectedGets: string[] = [];
  page.on("request", (request) => { if (/\/api\/admin\/(ops\/metrics|audit-logs)(\?|$)/.test(request.url())) protectedGets.push(request.url()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(cs);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "통합 대시보드", level: 1 })).toBeVisible();
  await expect(page.getByTestId("admin-coming-soon")).toHaveCount(0);

  const api = await page.evaluate(async () => (await fetch("/api/admin/dashboard", { cache: "no-store" })).json());
  const fmt = (v: number, unit: string) => `${v.toLocaleString("ko-KR")}${unit}`;
  await expect(page.getByTestId("dash-sellers-active")).toHaveText(fmt(api.sellers.ACTIVE, "곳"));
  await expect(page.getByTestId("dash-sellers-suspended")).toHaveText(fmt(api.sellers.SUSPENDED, "곳"));
  expect(api.sellers.SUSPENDED).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("dash-sellers-total")).toHaveText(fmt(api.sellers.total, "곳"));
  await expect(page.getByTestId("dash-sub-grace")).toHaveText(fmt(api.subscriptions.grace, "곳"));
  await expect(page.getByTestId("dash-orders-amount")).toHaveText(`${api.ordersToday.paidAmount.toLocaleString("ko-KR")}원`);
  await expect(page.getByTestId("dash-live")).toHaveText(fmt(api.liveBroadcasts, "곳"));
  await expect(page.locator(".ma-home-kpis > section")).toHaveCount(6);
  expect(protectedGets).toEqual([]); // CS는 DB 운영 지표·관리자 활동 조회를 요청하지 않는다.

  await page.getByRole("button", { name: "새로 고침" }).click();
  await expect(page.getByTestId("dash-sellers-total")).toBeVisible();
  await page.getByRole("link", { name: "구독 현황" }).first().click();
  await expect(page).toHaveURL(/\/admin\/billing\/subscriptions$/);
});
