import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 파트너스 상세의 발송 잔액·무상 지급(MA-012). 계정·파트너스·잔액은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const superEmail = `bal-super-${run}@example.com`;
const csEmail = `bal-cs-${run}@example.com`;
let db: PrismaClient;
let sellerId = "";

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: superEmail, passwordHash, name: "대표", role: "SUPER_ADMIN" },
      { email: csEmail, passwordHash, name: "상담", role: "CS" },
    ],
  });
  const seller = await db.seller.create({ data: { slug: `bal-${run}`, shopName: `잔액몰 ${run}`, status: "ACTIVE", approvedAt: new Date() } });
  sellerId = seller.id;
  await db.sellerMessageBalance.create({ data: { sellerId, paidBalance: 5000, freeBalance: 300, lowBalanceThreshold: 10000 } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function open(page: Page, email: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto(`/admin/partners/${sellerId}`);
}

test("CS도 잔액을 본다: 합계·유료·무상·부족 표시, 값 왼쪽 정렬, 무상 지급 버튼은 없다", async ({ page }) => {
  await open(page, csEmail);
  await expect(page.getByRole("heading", { name: "발송 잔액", level: 2 })).toBeVisible();
  await expect(page.getByTestId("balance-total")).toContainText("5,300원");
  await expect(page.getByTestId("balance-total")).toContainText("잔액 부족");
  await expect(page.getByTestId("balance-paid")).toHaveText("5,000원");
  await expect(page.getByTestId("balance-free")).toHaveText("300원");
  await expect(page.getByTestId("balance-mail")).toContainText("0통");
  await expect(page.getByRole("button", { name: "무상 지급" })).toHaveCount(0);
  const align = await page.getByTestId("balance-paid").evaluate((el) => getComputedStyle(el).textAlign);
  expect(["left", "start"]).toContain(align);
});

test("최고관리자 무상 지급: 입력 검사, 지급이 잔액·DB에 반영되고, 응답이 끊겨 다시 보내도 한 번만 지급된다", async ({ page }) => {
  await open(page, superEmail);
  await page.getByRole("button", { name: "무상 지급" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "지급" })).toBeDisabled();
  await dialog.getByLabel("금액").fill("10000001");
  await dialog.getByLabel("사유").fill("시험 지급");
  await expect(dialog.getByRole("button", { name: "지급" })).toBeDisabled();
  await dialog.getByLabel("금액").fill("1000");
  await expect(dialog.getByRole("button", { name: "지급" })).toBeEnabled();

  // 서버는 지급을 마쳤는데 응답만 끊긴 경우: 같은 창에서 다시 보내면 같은 요청 키라 한 번만 지급된다
  let first = true;
  await page.route("**/message-balance", async (route) => {
    if (route.request().method() === "POST" && first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "지급" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오.");
  expect((await db.sellerMessageBalance.findUniqueOrThrow({ where: { sellerId } })).freeBalance).toBe(1300);
  await dialog.getByRole("button", { name: "지급" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("이미 지급된 요청입니다.")).toBeVisible();
  await expect(page.getByTestId("balance-free")).toHaveText("1,300원");
  expect((await db.sellerMessageBalance.findUniqueOrThrow({ where: { sellerId } })).freeBalance).toBe(1300);

  // 새 창은 새 요청 키라 따로 지급된다
  await page.getByRole("button", { name: "무상 지급" }).click();
  await dialog.getByLabel("금액").fill("200");
  await dialog.getByLabel("사유").fill("추가 시험");
  await dialog.getByRole("button", { name: "지급" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("balance-free")).toHaveText("1,500원");
  await expect(page.getByTestId("balance-total")).toContainText("6,500원");
});
