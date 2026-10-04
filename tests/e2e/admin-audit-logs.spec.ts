import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 로그 추적(MA-070·071). 계정·파트너스·기록은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
// 조회 전용 계정(audit.read 있음)으로 조회만 한다. 화면에는 action·역할 코드가 보이면 안 된다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const readOnly = `log-ro-${run}@example.com`;
const shopName = `로그몰 ${run}`;
const DAY = 86_400_000;
let db: PrismaClient;
let sellerId = "";
let suspendLogId = "";

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.create({ data: { email: readOnly, passwordHash, name: "조회 시험", role: "READ_ONLY" } });
  const actor = await db.platformAdmin.create({ data: { email: `log-actor-${run}@example.com`, passwordHash, name: "처리자", role: "OPERATIONS" } });
  const seller = await db.seller.create({ data: { slug: `log-${run}`, shopName, status: "SUSPENDED", approvedAt: new Date() } });
  sellerId = seller.id;
  const now = Date.now();
  const suspend = await db.auditLog.create({
    data: {
      actorType: "PLATFORM_ADMIN",
      actorId: actor.id,
      sellerId,
      action: "admin.seller.suspend",
      targetType: "Seller",
      targetId: sellerId,
      reason: "약관 위반 확인",
      before: { status: "ACTIVE", suspendedReason: null },
      after: { status: "SUSPENDED" },
      ip: "203.0.113.7",
      userAgent: "시험 브라우저",
      createdAt: new Date(now - 2 * DAY),
    },
  });
  suspendLogId = suspend.id;
  await db.auditLog.create({ data: { actorType: "SYSTEM", sellerId, action: "order.auto_cancel", targetType: "Order", createdAt: new Date(now - DAY) } });
  await db.auditLog.create({ data: { actorType: "SYSTEM", sellerId, action: "zzz.unknown.thing", createdAt: new Date(now - 3 * DAY) } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function open(page: Page, path: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(readOnly);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto(path);
}

test("조회 전용 계정도 로그 추적을 본다: 파트너스 지정·종류·행위자·기간 필터, 코드 대신 이름, 값 왼쪽 정렬", async ({ page }) => {
  await open(page, `/admin/logs?sellerId=${sellerId}`);
  const rows = page.getByTestId("audit-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "주문 기록" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "파트너스 이용 정지" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "기타 기록" })).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText("admin.seller.suspend");
  await expect(page.locator("main")).not.toContainText("zzz.unknown.thing");
  const align = await page.locator(".tbl td").first().evaluate((el) => getComputedStyle(el).textAlign);
  expect(["left", "start"]).toContain(align);

  const search = () => page.getByRole("button", { name: "검색", exact: true }).click();
  await page.getByLabel("종류").selectOption("admin.seller.");
  await search();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("마스터 관리자");
  await page.getByLabel("종류").selectOption("");
  await page.getByLabel("행위자").selectOption("SYSTEM");
  await search();
  await expect(rows).toHaveCount(2);
  await page.getByLabel("행위자").selectOption("");

  await page.getByLabel("기록 시작일").fill("2026-10-10");
  await page.getByLabel("기록 종료일").fill("2026-10-01");
  await search();
  await expect(page.locator(".err[role=alert]")).toHaveText("시작일이 종료일보다 늦습니다.");
  const kst = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(ms));
  await page.getByLabel("기록 시작일").fill(kst(Date.now() - 2 * DAY));
  await page.getByLabel("기록 종료일").fill(kst(Date.now()));
  await search();
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(rows).toHaveCount(3);
  await page.getByRole("button", { name: "전체 보기" }).click();
  await expect(page.getByRole("button", { name: "전체 보기" })).toHaveCount(0);
});

test("로그 상세: 행위자 이름·역할, 바뀐 값(바꾸기 전·후)이 한글로 보이고 코드는 보이지 않는다", async ({ page }) => {
  await open(page, `/admin/logs/${suspendLogId}`);
  await expect(page.getByRole("heading", { name: "파트너스 이용 정지", level: 1 })).toBeVisible();
  await expect(page.getByText("처리자 (", { exact: false })).toContainText("운영");
  await expect(page.getByText("약관 위반 확인")).toBeVisible();
  await expect(page.getByText("203.0.113.7")).toBeVisible();
  await expect(page.getByRole("link", { name: shopName })).toBeVisible();
  const changes = page.getByTestId("audit-changes");
  await expect(changes.locator("tbody tr").filter({ hasText: "상태" })).toContainText("이용 중");
  await expect(changes.locator("tbody tr").filter({ hasText: "상태" })).toContainText("정지");
  await expect(page.locator("main")).not.toContainText("SUSPENDED");
  await expect(page.locator("main")).not.toContainText("admin.seller.suspend");
  await expect(page.locator(".loc-bar .crumb")).toContainText("로그 상세");
  await page.getByRole("link", { name: "로그 추적" }).first().click();
  await expect(page).toHaveURL(/\/admin\/logs$/);
  await page.goto("/admin/logs/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("기록을 찾을 수 없습니다.")).toBeVisible();
});
