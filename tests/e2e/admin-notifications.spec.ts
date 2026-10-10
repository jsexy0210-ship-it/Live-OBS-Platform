import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 알림 센터(MA-002): 저장형 알림의 검색·목록·처리 화면 연결을 확인한다. 폐기용 테스트 DB에만 실행한다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `nt-ro-${run}@example.com`;
const csEmail = `nt-cs-${run}@example.com`;
const title = `알림 문의 ${run}`;
const ids: Record<string, string> = {};
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "조회", role: "READ_ONLY" } });
  await db.platformAdmin.create({ data: { email: csEmail, passwordHash: await hashPassword(password), name: "고객지원", role: "CS" } });
  const seller = await db.seller.create({ data: { slug: `nt-${run}`, shopName: `알림몰 ${run}`, status: "ACTIVE", approvedAt: new Date() } });
  const user = await db.sellerUser.create({ data: { sellerId: seller.id, email: `nt-owner-${run}@example.com`, passwordHash: "x", name: "대표", isOwner: true } });
  const inq = await db.platformInquiry.create({ data: { sellerId: seller.id, createdBySellerUserId: user.id, category: "OTHER", title, lastMessageAt: new Date(Date.now() + 60_000) } });
  await db.platformInquiryMessage.create({ data: { sellerId: seller.id, inquiryId: inq.id, authorType: "SELLER_USER", sellerUserId: user.id, body: "내용입니다." } });
  await db.adminAlert.create({ data: { kind: "INQUIRY_URGENT", severity: "URGENT", title, body: "내용입니다.", linkPath: `/admin/support/inquiries/${inq.id}`, sellerId: seller.id, targetRoles: ["READ_ONLY", "CS"], occurredAt: new Date() } });
  ids.inquiry = inq.id;
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, account = email) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(account);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("저장형 알림 8열, 검색 필터와 처리 화면 연결", async ({ page }) => {
  await login(page);
  await page.goto("/admin/notifications");
  const row = page.getByTestId("notification-row").filter({ hasText: title });
  await expect(row).toContainText("긴급 문의");
  await expect(page.locator("[aria-label='알림 목록'] thead th")).toHaveCount(8);
  await expect(page.getByText(/읽지 않은 알림 \d+건/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "알림 규칙 요약" })).toBeVisible();
  await expect(page.getByText("방송 중 결제 승인 실패 3건 연속")).toBeVisible();
  await expect(page.locator(".notification-bottom table tbody")).not.toContainText("환불 승인 요청");
  await expect(page.getByText("집계 미연결")).toHaveCount(4);
  await page.getByPlaceholder("파트너스 이름").fill("없는 파트너스");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByText("검색 조건에 맞는 알림이 없습니다.")).toBeVisible();
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(row).toBeVisible();
  if (process.env.E2E_SCREENSHOTS === "1") {
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator(".lnb").evaluate(async (node) => { await Promise.all(node.getAnimations().map((animation) => animation.finished)); });
      await page.screenshot({ path: `${process.env.E2E_EVIDENCE_DIR ?? "tests/e2e/screenshots"}/MA-002-notifications-${width}.png`, fullPage: true });
    }
  }
  await row.getByRole("link", { name: "열기" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/support/inquiries/${ids.inquiry}`));
  await expect(page.getByTestId("inquiry-status")).toContainText("답변 대기");
});

test("처리 권한 역할은 알림 상태를 바꾸고 일괄 확인 후 종 배지를 갱신한다", async ({ page }) => {
  await login(page, csEmail);
  await page.goto("/admin/notifications");
  const row = page.getByTestId("notification-row").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("combobox", { name: `${title} 상태 변경` }).selectOption("IN_PROGRESS");
  await expect(row).toContainText("처리 중");
  await expect(row).toContainText("고객지원");
  await page.getByRole("button", { name: "모두 확인 처리" }).click();
  await expect(page.getByTestId("bell-badge")).toHaveCount(0);
});
