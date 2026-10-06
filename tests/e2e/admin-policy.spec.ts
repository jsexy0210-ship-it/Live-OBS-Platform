import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 플랫폼 기본 정책(MA-081): 정본 구역·편집·저장(확인 창)·입력 오류·취소, 조회 전용. 1440·1024·390 화면 증거를 남긴다.
// 폐기용 테스트 DB(이름이 _test로 끝남)에만 만든다.
const password = randomBytes(12).toString("base64url");
const email = `policy-${randomBytes(4).toString("hex")}@example.com`;
const roEmail = `policy-ro-${randomBytes(4).toString("hex")}@example.com`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email, passwordHash, name: "정책", role: "SUPER_ADMIN" },
      { email: roEmail, passwordHash, name: "조회", role: "READ_ONLY" },
    ],
  });
});
async function login(page: Page, who: string) {
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(who);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}
test.afterAll(async () => {
  await db.$disconnect();
});

test("최고관리자: 정본 구역 6개, 값을 바꾸면 확인 창을 거쳐 저장되고 입력 오류·취소가 동작한다. 조회 전용은 저장 버튼이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, email);
  await page.goto("/admin/settings/policy");
  await expect(page.getByRole("heading", { name: "플랫폼 기본 정책" })).toBeVisible();
  for (const t of ["가입 · 심사", "구독 · 청구", "방송 · 주문대기 · 방송 화면", "적립금 상한 (파트너스 정책 한도)", "보안 · 세션", "법적 문서"]) await expect(page.getByRole("heading", { name: t })).toBeVisible();
  const save = page.getByRole("button", { name: "저장", exact: true });
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("policy-sections").getByText("적용 예정").first()).toBeVisible();

  // 입력 오류: 요금 변경 사전 고지는 30일 미만 불가 → 저장 막힘, 취소로 되돌림
  const notice = page.getByLabel("요금 변경 사전 고지");
  await notice.fill("20");
  await expect(page.getByText("요금 변경 사전 고지는 30일 미만으로 줄일 수 없습니다")).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(notice).toHaveValue("30");

  // 저장: 확인 창에 바뀐 항목 요약 → 저장 → DB 반영
  await page.getByLabel("연체 → 잠금").fill("10");
  await save.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("정책 1개를 변경하시겠습니까?");
  await expect(dialog).toContainText("연체 → 잠금 7일 → 10일");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("정책을 저장했습니다")).toBeVisible();
  expect((await db.platformPolicy.findUniqueOrThrow({ where: { key: "overdueLockDays" } })).intValue).toBe(10);
  await page.reload();
  await expect(page.getByLabel("연체 → 잠금")).toHaveValue("10");
  await db.platformPolicy.deleteMany({ where: { key: "overdueLockDays" } }); // 폐기용 DB지만 다른 시험이 기본값에 기대므로 되돌린다

  for (const w of [1440, 1024, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/admin/settings/policy");
    await expect(page.getByRole("heading", { name: "가입 · 심사" })).toBeVisible();
    await page.screenshot({ path: `tests/e2e/screenshots/admin-policy-${w}.png`, fullPage: true });
  }
});

test("조회 전용: 설정은 최고관리자만이라 화면이 열리지 않는다(셸이 막음)", async ({ page }) => {
  await login(page, roEmail);
  await page.goto("/admin/settings/policy");
  await expect(page.getByText("이 화면을 볼 권한이 없습니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
});
