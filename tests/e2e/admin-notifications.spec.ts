import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 알림 센터(MA-002): 답변을 기다리는 문의가 알림으로 보이고, 「답변」을 누르면 문의 상세로 간다. 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `nt-ro-${run}@example.com`;
const title = `알림 문의 ${run}`;
const ids: Record<string, string> = {};
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "조회", role: "READ_ONLY" } });
  const seller = await db.seller.create({ data: { slug: `nt-${run}`, shopName: `알림몰 ${run}`, status: "ACTIVE", approvedAt: new Date() } });
  const user = await db.sellerUser.create({ data: { sellerId: seller.id, email: `nt-owner-${run}@example.com`, passwordHash: "x", name: "대표", isOwner: true } });
  const inq = await db.platformInquiry.create({ data: { sellerId: seller.id, createdBySellerUserId: user.id, category: "OTHER", title, lastMessageAt: new Date(Date.now() + 60_000) } });
  await db.platformInquiryMessage.create({ data: { sellerId: seller.id, inquiryId: inq.id, authorType: "SELLER_USER", sellerUserId: user.id, body: "내용입니다." } });
  ids.inquiry = inq.id;
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("답변 대기 문의가 알림으로 보이고, 건수는 서버 값과 같고, 「답변」은 문의 상세로 간다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/notifications");
  const api = await (await page.request.get("/api/admin/notifications")).json();
  const row = page.getByTestId("notification-row").filter({ hasText: title });
  await expect(row).toContainText("답변 대기 문의");
  await expect(page.getByTestId("notification-count")).toContainText(`처리할 알림 ${api.unreadCount}건`);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-notifications-1440.png" });
  await row.getByRole("link", { name: "답변" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/support/inquiries/${ids.inquiry}`));
  await expect(page.getByTestId("inquiry-status")).toContainText("답변 대기");
});
