import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 카페24식 틀: 청록 GNB·LNB, 역할별 메뉴 노출 차이, 로그인 → 홈 진입, 준비 중 화면.
// 마스터 관리자 계정은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { super: `shell-super-${run}@example.com`, cs: `shell-cs-${run}@example.com` };

test.beforeAll(async () => {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const passwordHash = await hashPassword(password);
    await db.platformAdmin.createMany({
      data: [
        { email: emails.super, passwordHash, name: "대표", role: "SUPER_ADMIN" },
        { email: emails.cs, passwordHash, name: "상담", role: "CS" },
      ],
    });
  } finally {
    await db.$disconnect();
  }
});

async function login(page: Page, email: string) {
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

const gnb = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });
const lnb = (page: Page) => page.getByRole("complementary", { name: "마스터 관리자 메뉴" });

test("최고관리자: 로그인하면 홈으로 들어가고, GNB 9개 대분류와 청록 바탕·같은 높이의 LNB 제목 줄·경로 줄이 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, emails.super);
  await expect(gnb(page).getByRole("link")).toHaveText(["홈", "파트너스", "구독·요금", "정산", "운영", "고객지원", "관리자", "로그", "설정"]);
  await expect(page.getByTestId("admin-coming-soon")).toBeVisible();
  const bg = await page.locator(".gnb").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(15, 118, 110)");
  const h = await page.evaluate(() => ({ lnb: document.querySelector(".lnb-h")!.getBoundingClientRect().height, loc: document.querySelector(".loc-bar")!.getBoundingClientRect().height }));
  expect(h.lnb).toBe(48);
  expect(h.loc).toBe(48);
  await gnb(page).getByRole("link", { name: "운영" }).click();
  await expect(lnb(page).getByRole("link", { name: "실시간 감시" })).toBeVisible();
  await gnb(page).getByRole("link", { name: "관리자" }).click();
  await expect(lnb(page).getByRole("link", { name: "관리자 계정" })).toBeVisible();
  await gnb(page).getByRole("link", { name: "로그" }).click();
  await expect(lnb(page).getByRole("link", { name: "로그 추적" })).toBeVisible();
});

test("CS: 최고관리자 전용 메뉴(실시간 감시·관리자 계정·시스템 설정)와 로그 추적이 숨겨지고, 주소로 들어가도 권한 안내만 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, emails.cs);
  await expect(gnb(page).getByRole("link", { name: "관리자" })).toHaveCount(0);
  await expect(gnb(page).getByRole("link", { name: "로그" })).toHaveCount(0);
  await gnb(page).getByRole("link", { name: "운영" }).click();
  await expect(lnb(page).getByRole("link", { name: "실시간 방송" })).toBeVisible();
  await expect(lnb(page).getByRole("link", { name: "실시간 감시" })).toHaveCount(0);
  await gnb(page).getByRole("link", { name: "설정" }).click();
  await expect(lnb(page).getByRole("link", { name: "파비콘·공유 카드" })).toBeVisible();
  await expect(lnb(page).getByRole("link", { name: "점검 모드" })).toHaveCount(0);
  await page.goto("/admin/logs");
  await expect(page.getByTestId("admin-coming-soon")).toHaveText("이 화면을 볼 권한이 없습니다");
});

test("메뉴에 없는 주소는 404, 화면 있는 메뉴(파비콘·공유 카드)는 그대로 열린다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto("/admin/nothing-here");
  await expect(page.getByTestId("admin-coming-soon")).toHaveCount(0);
  await expect(page.locator("body")).toContainText("404");
  await page.goto("/admin/settings/branding");
  await expect(page.getByRole("heading", { name: "파비콘 · 공유 카드" })).toBeVisible();
});
