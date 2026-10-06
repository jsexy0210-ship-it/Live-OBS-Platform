import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 인프라 · 비용(MA-120): 서버·DB·외부 연결·요금 구역, 외부 연결 만료일 저장, 단가 저장(확인 창), 최고관리자만. 1440·1024·390 화면 증거를 남긴다.
// 폐기용 테스트 DB(이름이 _test로 끝남)에만 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { su: `infra-su-${run}@example.com`, ops: `infra-ops-${run}@example.com` };
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.externalConnection.deleteMany({}); // 이전 실행이 남긴 만료일을 지워 저장 버튼이 켜지는 상태에서 시작한다
  await db.infraPriceSetting.deleteMany({});
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.su, passwordHash, name: "인프라", role: "SUPER_ADMIN" },
      { email: emails.ops, passwordHash, name: "운영", role: "OPERATIONS" },
    ],
  });
});
test.afterAll(async () => {
  await db.infraPriceSetting.deleteMany({});
  await db.externalConnection.deleteMany({});
  await db.$disconnect();
});
async function login(page: Page, who: string) {
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(who);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("최고관리자: 구역이 보이고 만료일·단가를 저장한다(단가는 확인 창), 화면 증거", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, emails.su);
  await page.goto("/admin/ops/infra");
  await expect(page.getByRole("heading", { name: "인프라 · 비용", level: 1 })).toBeVisible();
  await expect(page.getByTestId("infra-status")).toBeVisible();
  await expect(page.getByTestId("infra-kpi")).toContainText("이번 달 누적 요금");
  await expect(page.getByTestId("infra-server-row").first()).toBeVisible();
  for (const t of ["용량 · 서버", "데이터베이스 · 백업", "외부 연결 · 만료 · 상태", "단가 입력"]) await expect(page.getByRole("heading", { name: t })).toBeVisible();
  await expect(page.getByTestId("infra-cost-row").first()).toBeVisible();
  await expect(page.getByTestId("infra-refreshed")).toContainText("1분마다 자동 새로고침");

  // 만료일 저장(확인 창 없음, 로그 추적 기록은 서버)
  const conn = page.getByTestId("infra-conn-row").first();
  const date = conn.locator("input[type=date]");
  await date.fill("2030-01-31");
  await page.getByRole("button", { name: "만료일 저장" }).click();
  await expect(page.getByText("만료일을 저장했습니다")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("infra-conn-row").first().locator("input[type=date]")).toHaveValue("2030-01-31");
  await expect(page.getByTestId("infra-conn-row").first()).toContainText(/연결 전|정상|만료 임박|인증 오류/); // 시험 환경에는 외부 키가 없어 대개 「연결 전」

  // 단가 저장: 확인 창 → 저장 → 서버 행 단가 반영
  await page.getByLabel("서버 (월 1대) 단가").fill("77000");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("단가를 저장하시겠습니까?");
  await expect(dialog).toContainText("서버 (월 1대) 미입력 → 77000");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("단가를 저장했습니다")).toBeVisible();
  await expect(page.getByTestId("infra-cost-row").first()).toContainText("77,000원");

  for (const w of [1440, 1024, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/admin/ops/infra");
    await expect(page.getByTestId("infra-kpi")).toBeVisible();
    await page.screenshot({ path: `tests/e2e/screenshots/admin-infra-${w}.png`, fullPage: true });
  }
});

test("운영 관리자: 인프라 · 비용은 최고관리자만이라 화면이 열리지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, emails.ops);
  await page.goto("/admin/ops/infra");
  await expect(page.getByText("이 화면을 볼 권한이 없습니다")).toBeVisible();
  await expect(page.getByRole("link", { name: "인프라 · 비용" })).toHaveCount(0);
});
