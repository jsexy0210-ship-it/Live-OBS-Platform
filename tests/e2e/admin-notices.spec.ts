import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 공지 목록·작성·수정·삭제(MA-053·054). 계정은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { super: `nt-super-${run}@example.com`, cs: `nt-cs-${run}@example.com`, ops: `nt-ops-${run}@example.com` };
const t = { a: `점검 안내 ${run}`, draft: `초안 공지 ${run}` };
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.super, passwordHash, name: "대표", role: "SUPER_ADMIN" },
      { email: emails.cs, passwordHash, name: "상담", role: "CS" },
      { email: emails.ops, passwordHash, name: "운영", role: "OPERATIONS" },
    ],
  });
});
test.afterAll(async () => {
  await db.platformNotice.deleteMany({ where: { title: { contains: run } } });
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

test("최고관리자: 제목·본문 없이는 저장되지 않고, 게시·임시 저장이 목록과 DB에 반영된다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto("/admin/support/notices");
  await page.getByRole("link", { name: "공지 작성" }).first().click();
  await expect(page).toHaveURL(/\/notices\/new$/);
  await page.getByRole("button", { name: "지금 게시하기", exact: true }).click();
  await expect(page.getByText("제목을 입력해 주십시오.")).toBeVisible();
  await expect(page.getByText("내용을 입력해 주십시오.")).toBeVisible();

  await page.getByLabel("점검", { exact: true }).check();
  await page.getByLabel("제목").fill(t.a);
  await page.getByLabel("본문").fill("새벽 점검이 있습니다.");
  await expect(page.getByTestId("notice-preview")).toContainText(t.a);
  await page.getByRole("button", { name: "지금 게시하기", exact: true }).click();
  await expect(page.getByText("공지를 게시했습니다.")).toBeVisible();
  const row = page.getByTestId("notice-row").filter({ hasText: t.a });
  await expect(row).toContainText("게시 중");
  await expect(row).toContainText("점검");
  expect((await db.platformNotice.findFirst({ where: { title: t.a } }))?.publishedAt).not.toBeNull();

  await page.getByRole("link", { name: "공지 작성" }).first().click();
  await expect(page).toHaveURL(/\/notices\/new$/);
  await page.getByLabel("제목").fill(t.draft);
  await page.getByLabel("본문").fill("초안");
  await page.getByRole("button", { name: "임시 저장하기" }).click();
  await expect(page.getByText("임시 저장했습니다.")).toBeVisible();
  await page.getByLabel("상태", { exact: true }).selectOption("draft");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByTestId("notice-row").filter({ hasText: t.draft })).toContainText("임시 저장");
  await expect(page.getByTestId("notice-row").filter({ hasText: t.a })).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-notices-1440.png" });
});

test("최고관리자: 수정하면 반영되고, 다른 곳에서 먼저 고쳤으면 알린다. 삭제하면 목록에서 사라진다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto("/admin/support/notices");
  await page.getByTestId("notice-row").filter({ hasText: t.a }).getByRole("link", { name: "수정" }).click();
  await expect(page).toHaveURL(/\/notices\/[0-9a-f-]{36}$/);
  await page.getByLabel("제목").fill(`${t.a} 수정`);
  // 다른 관리자가 먼저 고친 상황: 버전을 올려 둔다
  await db.platformNotice.updateMany({ where: { title: t.a }, data: { version: { increment: 1 } } });
  await page.getByRole("button", { name: "지금 게시하기", exact: true }).click();
  await expect(page.getByText("다른 곳에서 먼저 수정됐습니다.")).toBeVisible();
  expect((await db.platformNotice.findFirst({ where: { title: t.a } }))?.title).toBe(t.a);

  await page.getByTestId("notice-row").filter({ hasText: t.a }).getByRole("link", { name: "수정" }).click();
  await expect(page).toHaveURL(/\/notices\/[0-9a-f-]{36}$/);
  await page.getByLabel("제목").fill(`${t.a} 수정`);
  await page.getByRole("button", { name: "지금 게시하기", exact: true }).click();
  await expect(page.getByTestId("notice-row").filter({ hasText: `${t.a} 수정` })).toHaveCount(1);

  await page.getByTestId("notice-row").filter({ hasText: t.draft }).getByRole("button", { name: "삭제" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("공지를 삭제했습니다.")).toBeVisible();
  await expect(page.getByTestId("notice-row").filter({ hasText: t.draft })).toHaveCount(0);
});

test("CS는 작성·삭제할 수 있고, 운영 담당은 목록만 보며 작성·수정·삭제 버튼이 없다", async ({ page }) => {
  const author = await db.platformAdmin.findFirstOrThrow({ where: { email: emails.super } });
  await db.platformNotice.create({ data: { title: `권한 확인 ${run}`, body: "본문", category: "GENERAL", audience: "PARTNERS", createdByAdminId: author.id, updatedByAdminId: author.id, publishedAt: new Date() } });
  await login(page, emails.cs);
  await page.goto("/admin/support/notices");
  await expect(page.getByRole("link", { name: "공지 작성" }).first()).toBeVisible();
  await page.context().clearCookies();
  await login(page, emails.ops);
  await page.goto("/admin/support/notices");
  await expect(page.getByTestId("notice-row").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "공지 작성" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "삭제" })).toHaveCount(0);
  await page.goto("/admin/support/notices/new");
  await expect(page.getByText("최고관리자와 CS 담당만 작성할 수 있습니다.")).toBeVisible();
});
