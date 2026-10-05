import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { fillDateTime } from "./dateInput";

// 마스터 관리자 요금제의 월 거래 메일 제공량(MA-021·022). 계정은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
// CS는 보기만, 최고관리자는 바꿀 수 있다(바로·적용 예정).
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const superEmail = `plan-super-${run}@example.com`;
const csEmail = `plan-cs-${run}@example.com`;
const opsEmail = `plan-ops-${run}@example.com`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: superEmail, passwordHash, name: "대표", role: "SUPER_ADMIN" },
      { email: csEmail, passwordHash, name: "상담", role: "CS" },
      { email: opsEmail, passwordHash, name: "운영", role: "OPERATIONS" },
    ],
  });
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
  await page.goto("/admin/billing/plans");
}
const row = (page: Page, name: string) => page.getByTestId("plan-row").filter({ hasText: name });

test("CS는 요금제별 월 제공량을 보기만 한다(이름으로, 변경 버튼 없음)", async ({ page }) => {
  await open(page, csEmail);
  await expect(page.getByTestId("plan-row")).toHaveCount(3);
  await expect(row(page, "오버레이 전용")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("OVERLAY_ONLY");
  await expect(page.getByRole("button", { name: "월 무료 메일 수량 변경" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "가격 변경" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "체험 한도 변경" })).toHaveCount(0);
  await expect(row(page, "쇼핑몰 통합").locator("td").nth(1)).toHaveText(/\d원$/);
  await expect(page.getByRole("columnheader", { name: "작업" })).toHaveCount(0);
  const align = await page.locator(".tbl td").first().evaluate((el) => getComputedStyle(el).textAlign);
  expect(align).toBe("center"); // 표 정렬 새 규칙(2026-10-05): 글 열(.col-text)이 아니면 데이터는 가운데
});

test("최고관리자: 월 제공량을 바로 바꾸고, 적용 예정으로 걸면 현재 값은 그대로이며, 잘못된 값은 막는다", async ({ page }) => {
  await open(page, superEmail);
  await row(page, "쇼핑몰 통합").getByRole("button", { name: "월 무료 메일 수량 변경" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("월 주문·배송 안내 메일 무료 수량").fill("10000001");
  await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
  await dialog.getByLabel("월 주문·배송 안내 메일 무료 수량").fill("250");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "쇼핑몰 통합").locator("td").nth(7)).toHaveText("250통");
  expect((await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } })).mailMonthlyQuota).toBe(250);

  const future = new Date(Date.now() + 3 * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 16);
  await row(page, "쇼핑몰 통합").getByRole("button", { name: "월 무료 메일 수량 변경" }).click();
  await dialog.getByLabel("월 주문·배송 안내 메일 무료 수량").fill("400");
  await fillDateTime(dialog, "바뀌는 시각", future);
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toHaveCount(0);
  const r = row(page, "쇼핑몰 통합");
  await expect(r.locator("td").nth(7)).toHaveText("250통");
  await expect(r.locator("td").nth(8)).toHaveText("400통");
  await expect(r.locator("td").nth(9)).not.toHaveText("-");
  const saved = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
  expect([saved.mailMonthlyQuota, saved.nextMailQuota]).toEqual([250, 400]);
});

test("최고관리자: 가격 변경은 전·후 금액과 30일 안내를 보여 주고 한 번 더 확인한 뒤 저장한다", async ({ page }) => {
  const before = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
  try {
    await open(page, superEmail);
    await row(page, "쇼핑몰 통합").getByRole("button", { name: "가격 변경" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("기존 구독자는 30일 뒤 첫 결제부터 적용됩니다");
    await dialog.getByLabel("판매가").fill(String(before.listPrice + 1));
    await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    const newList = before.listPrice + 1000;
    const newSale = before.salePrice + 500;
    await dialog.getByLabel("정가").fill(String(newList));
    await dialog.getByLabel("판매가").fill(String(newSale));
    await expect(dialog.getByTestId("price-diff")).toContainText(`${before.listPrice.toLocaleString("ko-KR")}원 → ${newList.toLocaleString("ko-KR")}원`);
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(dialog.getByRole("alert")).toContainText("위 금액으로 바꾸시겠습니까?");
    expect((await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } })).salePrice).toBe(before.salePrice);
    await dialog.getByRole("button", { name: "가격 변경 확정" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row(page, "쇼핑몰 통합").locator("td").nth(2)).toHaveText(`${newSale.toLocaleString("ko-KR")}원`);
    const saved = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
    expect([saved.listPrice, saved.salePrice]).toEqual([newList, newSale]);
  } finally {
    await db.subscriptionPlan.update({ where: { code: "INTEGRATED" }, data: { listPrice: before.listPrice, salePrice: before.salePrice } });
  }
});

test("운영 담당: 체험 한도만 바꿀 수 있고(가격·제공량 버튼 없음), 저장하면 목록과 DB에 반영된다", async ({ page }) => {
  const before = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
  try {
    await open(page, opsEmail);
    await expect(page.getByRole("button", { name: "가격 변경" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "월 무료 메일 수량 변경" })).toHaveCount(0);
    await row(page, "오버레이 전용").getByRole("button", { name: "체험 한도 변경" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("저장 용량").fill("10000001");
    await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
    await dialog.getByLabel("알림톡·문자").fill("120");
    await dialog.getByLabel("구매자 본인확인").fill("60");
    await dialog.getByLabel("저장 용량").fill("2048");
    await dialog.getByRole("button", { name: "저장" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row(page, "오버레이 전용").locator("td").nth(4)).toHaveText("120건");
    await expect(row(page, "오버레이 전용").locator("td").nth(6)).toHaveText("2,048MB");
    const saved = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    expect([saved.trialMessageLimit, saved.trialIdentityLimit, saved.trialStorageMb]).toEqual([120, 60, 2048]);
  } finally {
    await db.subscriptionPlan.update({ where: { code: "OVERLAY_ONLY" }, data: { trialMessageLimit: before.trialMessageLimit, trialIdentityLimit: before.trialIdentityLimit, trialStorageMb: before.trialStorageMb } });
  }
});
