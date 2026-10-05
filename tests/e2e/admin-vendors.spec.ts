import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 외부 서비스 연동(MA-087): 분야 탭·업체 카드, 선택 확인, 가중치 합계 검사, 업체 등록(평가를 모두 채우면 점수), 조회 전용은 권한 안내만 본다. 폐기용 테스트 DB에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const superEmail = `vd-su-${run}@example.com`;
const roEmail = `vd-ro-${run}@example.com`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.create({ data: { email: superEmail, passwordHash, name: "업체최고", role: "SUPER_ADMIN" } });
  await db.platformAdmin.create({ data: { email: roEmail, passwordHash, name: "업체조회", role: "READ_ONLY" } });
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

test("최고관리자: 카드 보기 → 선택 확인 → 가중치 합계 검사 → 업체 등록 점수", async ({ page }) => {
  await login(page, superEmail);
  await page.goto("/admin/settings/vendors");
  const cards = page.getByTestId("vendor-card");
  await expect(cards.filter({ hasText: "NICEPAY" })).toContainText("추천");
  await expect(cards.filter({ hasText: "NICEPAY" })).toContainText("평가 중 0/7");

  // 선택: 아직 선택되지 않은 업체 하나를 확인 창을 거쳐 고른다(같은 DB로 다시 돌려도 되게 이름을 읽어 쓴다)
  const target = cards.filter({ has: page.getByRole("button", { name: "선택", exact: true }) }).first();
  const targetName = (await target.locator("b").first().innerText()).trim();
  await target.getByRole("button", { name: "선택", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("대표님 승인 뒤");
  await page.getByRole("dialog").getByRole("button", { name: "선택", exact: true }).click();
  await expect(cards.filter({ hasText: targetName })).toContainText("사용 중");
  await expect(cards.filter({ hasText: targetName }).getByRole("button", { name: "선택됨" })).toBeDisabled();

  // 가중치: 합계가 100이 아니면 저장 못 함
  await page.getByRole("button", { name: "점수 가중치 편집" }).click();
  await expect(page.getByTestId("weights-total")).toContainText("100 / 100");
  await page.getByLabel("수수료").fill("29");
  await expect(page.getByTestId("weights-total")).toContainText("99 / 100");
  await expect(page.getByRole("dialog").getByRole("button", { name: "저장" })).toBeDisabled();
  await page.getByLabel("수수료").fill("30");
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();

  // 등록: 평가를 모두 채우면 점수(만점 100)
  await page.getByRole("button", { name: "업체 등록" }).first().click();
  const name = `시험업체 ${run}`;
  await page.getByLabel("업체 이름").fill(name);
  for (const key of ["fee", "setupFee", "recurring", "methods", "api", "stability", "settlement"]) await page.locator(`#vr-${key}`).selectOption("10");
  await page.getByRole("dialog").getByRole("button", { name: "저장" }).click();
  await expect(cards.filter({ hasText: name })).toContainText("100점");

  // 분야 탭은 주소에 남는다
  await page.getByRole("button", { name: "배송·송장" }).click();
  await expect(page).toHaveURL(/cat=SHIPPING/);
  await expect(cards.filter({ hasText: "굿스플로" })).toContainText("추천");
});

test("조회 전용: 메뉴에 없고, 주소로 들어가도 변경 화면 없이 권한 안내만 나온다", async ({ page }) => {
  await login(page, roEmail);
  await page.goto("/admin/settings/vendors");
  await expect(page.getByText("이 화면을 볼 권한이 없습니다")).toBeVisible();
  await expect(page.getByTestId("vendor-card")).toHaveCount(0);
});
