import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 가입 신청 목록·상세·승인·반려(MA-013·014). 계정·신청은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { super: `ap-super-${run}@example.com`, cs: `ap-cs-${run}@example.com` };
const shops = { approve: `승인몰 ${run}`, reject: `반려몰 ${run}` };
const ids: Record<string, string> = {};
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.super, passwordHash, name: "대표", role: "SUPER_ADMIN" },
      { email: emails.cs, passwordHash, name: "상담", role: "CS" },
    ],
  });
  const plan = await db.subscriptionPlan.findFirst({ where: { code: "OVERLAY_ONLY" } });
  for (const key of ["approve", "reject"] as const) {
    const s = await db.seller.create({
      data: {
        slug: `ap-${key}-${run}`,
        shopName: shops[key],
        status: "PENDING",
        planId: plan?.id,
        reviewReasons: ["business_lookup_failed", "mail_order_lookup_failed"],
        businessInfo: { companyName: `시험상사 ${key}`, businessNumber: "123-45-67890", representativeName: "홍길동", businessInfoValid: null },
      },
    });
    ids[key] = s.id;
  }
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

test("최고관리자: 목록에 확인 필요 항목이 보이고, 상세에서 승인하면 운영 중으로 바뀐다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto("/admin/partners/applications");
  const row = page.getByTestId("application-row").filter({ hasText: shops.approve });
  await expect(row).toContainText("국세청 조회 실패");
  await row.getByRole("link", { name: "상세" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/partners/applications/${ids.approve}$`));
  await expect(page.getByRole("heading", { name: "확인할 것" })).toBeVisible();
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expect(page.getByText("가입을 승인했습니다.")).toBeVisible();
  // 처리 뒤에는 목록으로 강제 복귀하지 않고 다음 신청(없으면 목록)으로 넘어간다
  await expect(page).not.toHaveURL(new RegExp(`/admin/partners/applications/${ids.approve}$`));
  const after = await db.seller.findUnique({ where: { id: ids.approve } });
  expect(after?.status).toBe("ACTIVE");
  await page.goto("/admin/partners/applications");
  await expect(page.getByTestId("application-row").filter({ hasText: shops.approve })).toHaveCount(0);
});

test("최고관리자: 반려는 사유가 있어야 하고, 반려 사유가 DB에 남는다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto(`/admin/partners/applications/${ids.reject}`);
  await page.getByRole("button", { name: "반려", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "반려", exact: true })).toBeDisabled();
  await dialog.getByLabel("추가 안내").fill("사업자 정보가 확인되지 않습니다.");
  await dialog.getByRole("button", { name: "반려", exact: true }).click();
  await expect(page.getByText("가입을 반려했습니다.")).toBeVisible();
  const after = await db.seller.findUnique({ where: { id: ids.reject } });
  expect(after?.status).toBe("REJECTED");
  expect(after?.rejectedReason).toBe("사업자 정보가 확인되지 않습니다.");
});

test("상담(CS): 신청 내용은 볼 수 있지만 승인·반려 버튼은 없다", async ({ page }) => {
  const s = await db.seller.create({ data: { slug: `ap-cs-${run}`, shopName: `상담용몰 ${run}`, status: "PENDING", reviewReasons: ["business_not_active"] } });
  await login(page, emails.cs);
  await page.goto(`/admin/partners/applications/${s.id}`);
  await expect(page.getByRole("heading", { name: "확인할 것" })).toBeVisible();
  await expect(page.getByText("휴업·폐업 사업자")).toBeVisible();
  await expect(page.getByRole("button", { name: "승인", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "반려", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-application-detail-cs.png" });
});
