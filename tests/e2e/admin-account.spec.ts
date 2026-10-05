import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 내 계정(MA-090): 비밀번호를 바꾸면 새 비밀번호로 로그인되고, 틀린 현재 비밀번호·확인 불일치는 막힌다. 폐기용 테스트 DB에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const newPassword = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `acct-${run}@example.com`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "내계정", role: "OPERATIONS" } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, pw: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(pw);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("확인이 다르면 막히고, 현재 비밀번호가 틀리면 오류, 맞으면 바뀌어 새 비밀번호로 로그인된다", async ({ page }) => {
  await login(page, password);
  await page.goto("/admin/account");
  await expect(page.getByText(email)).toBeVisible();
  const submit = page.getByRole("button", { name: "비밀번호 변경" });

  await page.getByLabel("현재 비밀번호").fill(password);
  await page.getByLabel("새 비밀번호", { exact: true }).fill(newPassword);
  await page.getByLabel("새 비밀번호 확인").fill(`${newPassword}x`);
  await expect(page.getByText("새 비밀번호가 서로 다릅니다.")).toBeVisible();
  await expect(submit).toBeDisabled();

  await page.getByLabel("현재 비밀번호").fill(`${password}x`);
  await page.getByLabel("새 비밀번호 확인").fill(newPassword);
  await submit.click();
  await expect(page.locator("form").getByRole("alert")).toContainText("현재 비밀번호가 맞지 않습니다");

  await page.getByLabel("현재 비밀번호").fill(password);
  await submit.click();
  await expect(page.getByText(/비밀번호를 바꿨습니다/)).toBeVisible();
  await expect(page.getByLabel("현재 비밀번호")).toHaveValue("");

  await page.context().clearCookies();
  await login(page, newPassword);
});
