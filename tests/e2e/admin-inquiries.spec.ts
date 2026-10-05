import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 파트너스 문의 목록·상세(MA-051·052): 목록 탭, 답변(최고관리자·CS), 종료, 권한(조회 전용은 보기만).
// 계정·파트너스·문의는 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { cs: `iq-cs-${run}@example.com`, ro: `iq-ro-${run}@example.com` };
const shop = `문의몰 ${run}`;
const ids: Record<string, string> = {};
let db: PrismaClient;

async function inquiry(key: string, title: string) {
  const sellerId = ids.seller;
  const i = await db.platformInquiry.create({ data: { sellerId, createdBySellerUserId: ids.user, category: "BILLING", title, lastMessageAt: new Date() } });
  await db.platformInquiryMessage.create({ data: { sellerId, inquiryId: i.id, authorType: "SELLER", sellerUserId: ids.user, body: `${title} 내용입니다.` } });
  ids[key] = i.id;
}

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.cs, passwordHash, name: "상담", role: "CS" },
      { email: emails.ro, passwordHash, name: "조회", role: "READ_ONLY" },
    ],
  });
  const seller = await db.seller.create({ data: { slug: `iq-${run}`, shopName: shop, status: "ACTIVE", approvedAt: new Date() } });
  ids.seller = seller.id;
  ids.user = (await db.sellerUser.create({ data: { sellerId: seller.id, email: `iq-owner-${run}@example.com`, passwordHash, name: "대표", isOwner: true } })).id;
  await inquiry("reply", `결제 문의 ${run}`);
  await inquiry("ro", `조회 문의 ${run}`);
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, email: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("목록: 답변 대기 탭에 문의가 보이고, 종료 탭에는 보이지 않는다", async ({ page }) => {
  await login(page, emails.ro);
  await page.goto(`/admin/support/inquiries?sellerId=${ids.seller}`);
  const row = page.getByTestId("inquiry-row").filter({ hasText: `결제 문의 ${run}` });
  await expect(row).toContainText(shop);
  await expect(row).toContainText("답변 대기");
  await expect(page.getByRole("button", { name: /^답변 대기 \d+$/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^종료/ }).click();
  await expect(page.getByTestId("inquiry-row").filter({ hasText: `결제 문의 ${run}` })).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-inquiries-1440.png" });
});

test("CS: 답변을 보내면 답변 완료가 되고 DB에 남고, 문의를 종료하면 답변 칸이 사라진다", async ({ page }) => {
  await login(page, emails.cs);
  await page.goto(`/admin/support/inquiries/${ids.reply}`);
  await expect(page.getByTestId("inquiry-status")).toContainText("답변 대기");
  await expect(page.getByTestId("inquiry-message")).toHaveCount(1);
  const send = page.getByRole("button", { name: "답변 보내기" });
  await expect(send).toBeDisabled();
  await page.getByLabel("답변 내용").fill("확인해 보겠습니다.\n잠시만 기다려 주십시오.");
  await send.click();
  await expect(page.getByText("답변을 보냈습니다.")).toBeVisible();
  await expect(page.getByTestId("inquiry-status")).toContainText("답변 완료");
  await expect(page.getByTestId("inquiry-message")).toHaveCount(2);
  await expect(page.getByTestId("inquiry-message").nth(1)).toHaveAttribute("data-author", "PLATFORM");
  const answered = await db.platformInquiry.findUniqueOrThrow({ where: { id: ids.reply } });
  expect(answered.status).toBe("ANSWERED");
  await page.getByRole("button", { name: "문의 종료" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "종료", exact: true }).click();
  await expect(page.getByText("문의를 종료했습니다.")).toBeVisible();
  await expect(page.getByTestId("inquiry-status")).toContainText("종료");
  await expect(page.getByLabel("답변 내용")).toHaveCount(0);
  expect((await db.platformInquiry.findUniqueOrThrow({ where: { id: ids.reply } })).status).toBe("CLOSED");
});

test("조회 전용: 대화는 보이지만 답변 칸 대신 안내만 보인다", async ({ page }) => {
  await login(page, emails.ro);
  await page.goto(`/admin/support/inquiries/${ids.ro}`);
  await expect(page.getByTestId("inquiry-message")).toHaveCount(1);
  await expect(page.getByLabel("답변 내용")).toHaveCount(0);
  await expect(page.getByText("답변과 종료는 최고관리자와 CS만 할 수 있습니다.")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/admin-inquiry-detail-1440.png" });
});
