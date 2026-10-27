import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 확인 창 적용(UX 감사): 도우미 답변 자료 삭제는 브라우저 기본 창이 아니라 공통 확인 창을 거치고, 취소하면 지워지지 않는다.
// 폐기용 테스트 DB(이름이 _test로 끝남)에만 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `confirm-${run}@example.com`;
const title = `확인창 자료 ${run}`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "확인", role: "SUPER_ADMIN" } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

test("도우미 답변 자료 삭제: 공통 확인 창, 취소하면 남고 지우기를 눌러야 지워진다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/support/assistant");
  await page.getByRole("link", { name: "문서 등록" }).click();
  await expect(page).toHaveURL(/\/admin\/support\/assistant\/new(?:\?|$)/);
  await page.getByLabel("제목").fill(title);
  await page.getByLabel("내용").fill("시험용 내용입니다.");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const row = page.getByTestId("doc-row").filter({ hasText: title });
  await expect(row).toBeVisible();
  const created = await db.assistantDoc.findFirstOrThrow({ where: { title, deletedAt: null } });
  await row.getByRole("link", { name: "상세", exact: true }).click();
  await expect(page.getByLabel("제목")).toHaveValue(title);

  let nativeDialog = false;
  page.on("dialog", (d) => {
    nativeDialog = true;
    void d.dismiss();
  });
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`「${title}」을(를) 지우시겠습니까?`);
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("제목")).toHaveValue(title);
  expect(await db.assistantDoc.findUniqueOrThrow({ where: { id: created.id } })).toEqual(created);
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "지우기" }).click();
  await expect(page).toHaveURL(/\/admin\/support\/assistant(?:\?|$)/);
  await expect(page.getByRole("link", { name: "문서 등록" })).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(await db.assistantDoc.count({ where: { id: created.id, deletedAt: null } })).toBe(0);
  const removed = await db.assistantDoc.findUniqueOrThrow({ where: { id: created.id } });
  expect(removed.deletedAt).not.toBeNull();
  expect(removed.published).toBe(false);
  expect(removed.version).toBe(created.version + 1);
  expect(nativeDialog).toBe(false);
});
