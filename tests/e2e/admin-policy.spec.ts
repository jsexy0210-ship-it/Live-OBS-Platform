import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 플랫폼 기본 정책(MA-081, 읽기 전용): 정본 구역이 모두 보이고 서버 값이 없는 행은 「준비 중」, 무료 체험 일수는 요금제에서 온다. 1440·1024·390 화면 증거를 남긴다.
// 폐기용 테스트 DB(이름이 _test로 끝남)에만 만든다.
const password = randomBytes(12).toString("base64url");
const email = `policy-${randomBytes(4).toString("hex")}@example.com`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "정책", role: "SUPER_ADMIN" } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

test("최고관리자: 정본 구역 6개가 보이고 값 없는 행은 준비 중, 화면 증거를 남긴다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/settings/policy");
  await expect(page.getByRole("heading", { name: "플랫폼 기본 정책" })).toBeVisible();
  for (const t of ["가입 · 심사", "구독 · 청구", "방송 · 주문대기 · 방송 화면", "적립금 상한 (파트너스 정책 한도)", "보안 · 세션", "법적 문서"]) await expect(page.getByRole("heading", { name: t })).toBeVisible();
  await expect(page.getByTestId("policy-sections").getByText("준비 중").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "변경 이력" })).toBeVisible();
  for (const w of [1440, 1024, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "가입 · 심사" })).toBeVisible();
    await page.screenshot({ path: `tests/e2e/screenshots/admin-policy-${w}.png`, fullPage: true });
  }
});
