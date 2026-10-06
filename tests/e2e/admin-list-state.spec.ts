import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 목록 상태 보존(UX-03): 조건·탭이 주소에 남고, 상세 → 「목록」·브라우저 Back에서 그대로 돌아오며, 직접 진입한 상세의 「목록」은 부모 목록으로 간다.
// 계정·파트너스·문의는 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `ls-cs-${run}@example.com`;
const shop = `상태몰 ${run}`;
const ids: Record<string, string> = {};
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.create({ data: { email, passwordHash, name: "상담", role: "CS" } });
  const seller = await db.seller.create({ data: { slug: `ls-${run}`, shopName: shop, status: "ACTIVE", approvedAt: new Date() } });
  const user = await db.sellerUser.create({ data: { sellerId: seller.id, email: `ls-owner-${run}@example.com`, passwordHash, name: "대표", isOwner: true } });
  ids.seller = seller.id;
  const inq = await db.platformInquiry.create({ data: { sellerId: seller.id, createdBySellerUserId: user.id, category: "OTHER", title: `닫힌 문의 ${run}`, status: "CLOSED", closedAt: new Date(), lastMessageAt: new Date() } });
  await db.platformInquiryMessage.create({ data: { sellerId: seller.id, inquiryId: inq.id, authorType: "SELLER_USER", sellerUserId: user.id, body: "내용입니다." } });
  ids.inquiry = inq.id;
  const admin = await db.platformAdmin.findFirstOrThrow({ where: { email } });
  const notice = await db.platformNotice.create({ data: { title: `상태 공지 ${run}`, body: "본문", category: "GENERAL", audience: "PARTNERS", createdByAdminId: admin.id, updatedByAdminId: admin.id, publishedAt: new Date() } });
  ids.notice = notice.id;
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

test("파트너스 목록: 검색어가 주소에 남고, 상세 → 「파트너스 목록」·Back·새로고침에서 그대로 돌아온다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/partners");
  await page.getByLabel("검색어", { exact: true }).fill(run);
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page).toHaveURL(new RegExp(`q=${run}`));
  await expect(page.getByRole("link", { name: shop })).toBeVisible();
  await page.getByRole("link", { name: shop }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/partners/${ids.seller}`));
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/partners\\?q=${run}`));
  await expect(page.getByLabel("검색어", { exact: true })).toHaveValue(run);
  await page.reload();
  await expect(page.getByLabel("검색어", { exact: true })).toHaveValue(run);
  await expect(page.getByRole("link", { name: shop })).toBeVisible();
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(page).toHaveURL(/\/admin\/partners$/);
});

test("파트너스 문의: 탭·파트너스 지정이 주소에 남고, 상세 「목록」과 브라우저 Back 모두 같은 목록으로 돌아온다", async ({ page }) => {
  await login(page);
  await page.goto(`/admin/support/inquiries?sellerId=${ids.seller}`);
  await page.getByRole("radio", { name: /^종료/ }).check();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`status=CLOSED`));
  const row = page.getByTestId("inquiry-row").filter({ hasText: `닫힌 문의 ${run}` });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "보기" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/support/inquiries/${ids.inquiry}`));
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`status=CLOSED.*sellerId=${ids.seller}|sellerId=${ids.seller}.*status=CLOSED`));
  await expect(page.getByRole("radio", { name: /^종료/ })).toBeChecked();
  await row.getByRole("link", { name: "보기" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/support/inquiries/${ids.inquiry}`));
  await expect(page.getByTestId("inquiry-status")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("radio", { name: /^종료/ })).toBeChecked();
  await expect(row).toBeVisible();
});

test("직접 진입한 상세의 「목록」은 부모 목록으로 가고, 기록이 하나 더 쌓이지 않는다", async ({ page }) => {
  await login(page);
  await page.goto(`/admin/support/inquiries/${ids.inquiry}`);
  const before = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/support\/inquiries$/);
  expect(await page.evaluate(() => history.length)).toBe(before);
});

test("자동 연결 작업: 걸러 보기가 주소에서 와서 눌린 탭으로 보이고, 없는 값은 「전체」로 본다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/ops/automation?filter=failed");
  await expect(page.getByRole("button", { name: "실패", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/admin/ops/automation?filter=nope");
  await expect(page.getByRole("button", { name: "전체", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("공지 목록: 제목 검색이 주소에 남고, 수정 화면에서 Back하면 검색 조건 그대로 돌아온다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/support/notices");
  await page.getByLabel("제목").fill(run);
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page).toHaveURL(new RegExp(`q=${run}`));
  const row = page.getByTestId("notice-row").filter({ hasText: `상태 공지 ${run}` });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: `상태 공지 ${run}` }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/support/notices/${ids.notice}`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`q=${run}`));
  await expect(page.getByLabel("제목")).toHaveValue(run);
  await expect(row).toBeVisible();
});
