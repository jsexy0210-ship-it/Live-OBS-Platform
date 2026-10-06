import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-034 적립금 실제 지급 스위치: 기본 꺼짐, 켜기·끄기 모두 확인 창을 거친다(켤 때 confirm: true), 대표자만 변경. 테스트 DB에서 켜고 끈다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
const URL_PATH = "/seller/rewards/live-payout";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function withDb<T>(fn: (db: PrismaClient, sellerId: string) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com", isOwner: true }, select: { sellerId: true } });
    return await fn(db, owner.sellerId);
  } finally {
    await db.$disconnect();
  }
}

// 폐기용 DB를 처음 상태로: 실지급 꺼짐, 변경 기록 없음(정책 행이 있으면 값만 되돌린다)
const reset = () =>
  withDb((db, sellerId) =>
    db.rewardPolicy.updateMany({ where: { sellerId }, data: { livePayoutEnabled: false, livePayoutChangedAt: null, livePayoutChangedBy: null } }),
  );

async function open(page: Page, email = "demo-owner@example.com") {
  await page.goto(`/seller/login?next=${encodeURIComponent(URL_PATH)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${URL_PATH}$`));
}

// 켜기 조건(적립 정책 설정 완료)을 채운다: 등급 하나에 카드 적립률을 둔 정책. 끝나면 정책 행은 남겨 두고 켜짐만 되돌린다
const ensurePolicy = () =>
  withDb(async (db, sellerId) => {
    const grade = await db.memberGrade.findFirstOrThrow({ where: { sellerId }, select: { id: true } });
    await db.rewardPolicy.upsert({ where: { sellerId }, create: { sellerId, rates: { [grade.id]: { card: 1 } } }, update: { rates: { [grade.id]: { card: 1 } } } });
  });
const dropRates = () => withDb((db, sellerId) => db.rewardPolicy.updateMany({ where: { sellerId }, data: { rates: {} } }));

const isPut = (r: { request(): { method(): string }; url(): string }) => r.request().method() === "PUT" && r.url().endsWith("/api/seller/reward-live-payout");

test.afterAll(reset);

test("기본은 꺼짐. 켜기·끄기 모두 확인 창을 거치고(켤 때 confirm: true), 켜면 안내 띠·변경 기록이 보인다", async ({ page }) => {
  await reset();
  await ensurePolicy();
  await open(page);
  await expect(page.getByRole("heading", { name: "실제 지급 켜기" })).toBeVisible();
  await expect(page.getByTestId("live-pending")).toContainText("건");
  await expect(page.getByTestId("live-conditions")).toContainText("적립 정책 설정 완료");
  await expect(page.getByTestId("live-status")).toContainText("현재 꺼짐");
  await expect(page.getByTestId("live-on")).toHaveCount(0);

  await shot(page, "SA-034");

  // 취소하면 아무것도 보내지 않는다
  await page.getByTestId("live-on-button").click();
  const dialog = page.getByRole("dialog", { name: "적립금을 실제로 지급하도록 켜시겠습니까?" });
  await expect(dialog).toContainText("로그 추적에 남습니다");
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("live-status")).toContainText("현재 꺼짐");

  // 확인 창에서 켠다
  await page.getByTestId("live-on-button").click();
  const on = page.waitForResponse(isPut);
  await dialog.getByRole("button", { name: "실제 지급 켜기" }).click();
  const res = await on;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ enabled: true, confirm: true });
  await expect(page.getByText("실제 지급을 켰습니다")).toBeVisible();
  await expect(page.getByTestId("live-on")).toContainText("실제 지급 켜짐");
  await expect(page.getByTestId("live-on")).toContainText(/\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}부터/);

  // 다시 열어도 켜져 있다
  await page.reload();
  await expect(page.getByTestId("live-on")).toContainText("실제 지급 켜짐");

  // 끄기도 확인 창을 거쳐 {enabled:false}
  await page.getByTestId("live-off").click();
  const off = page.waitForResponse(isPut);
  await page.getByRole("dialog", { name: "적립금 실제 지급을 끄시겠습니까?" }).getByRole("button", { name: "실제 지급 끄기" }).click();
  expect((await off).request().postDataJSON()).toEqual({ enabled: false });
  await expect(page.getByText("실제 지급을 껐습니다")).toBeVisible();
  await expect(page.getByTestId("live-status")).toContainText("현재 꺼짐");
  await expect(page.getByTestId("live-on")).toHaveCount(0);
  // 전환 이력: 끔 · 켬이 최근 순으로 남는다
  await expect(page.getByTestId("live-history").locator("tbody tr").first()).toContainText("끔");
  await expect(page.getByTestId("live-history")).toContainText("켬");
});

test("켜기 조건을 채우지 못하면 버튼이 잠기고 부족한 조건을 알려 준다", async ({ page }) => {
  await reset();
  await ensurePolicy();
  await dropRates();
  await open(page);
  await expect(page.getByTestId("live-conditions")).toContainText("미충족");
  await expect(page.getByRole("link", { name: "적립 정책 설정" })).toHaveAttribute("href", "/seller/rewards");
  await expect(page.getByTestId("live-on-button")).toBeDisabled();
});

test("켠 뒤 남은 대기분은 이어서 지급하며 「지급 중… N / M」을 보여 준다", async ({ page }) => {
  await reset();
  await ensurePolicy();
  await open(page);
  const now = new Date().toISOString();
  await page.route("**/api/seller/reward-live-payout", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ livePayout: { enabled: true, changedAt: now, changedByName: "대표자" }, settlement: { settled: 2, settledAmount: 2000, revokedAmount: 0, failed: 0, remaining: 3, skipped: null } }),
    });
  });
  await page.route("**/api/seller/reward-live-payout/settle", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settlement: { settled: 3, settledAmount: 3000, revokedAmount: 0, failed: 0, remaining: 0, skipped: null } }) });
  });
  await page.getByTestId("live-on-button").click();
  await page.getByRole("dialog", { name: "적립금을 실제로 지급하도록 켜시겠습니까?" }).getByRole("button", { name: "실제 지급 켜기" }).click();
  await expect(page.getByTestId("live-progress")).toContainText("지급 중… 2 / 5");
  await expect(page.getByText("실제 지급을 켰습니다 · 5건 지급")).toBeVisible();
  await expect(page.getByTestId("live-progress")).toHaveCount(0);
});

test("대표자가 아니면 상태만 보고 바꾸는 버튼은 없다(회원·적립금 권한이 있어도)", async ({ page }) => {
  await reset();
  // 회원·적립금 권한을 잠깐 준 직원(대표자 아님). 끝나면 원래 권한으로 되돌린다
  const setPerms = (permissions: string[]) => withDb((db, sellerId) => db.sellerUser.updateMany({ where: { sellerId, email: "demo-staff@example.com" }, data: { permissions: permissions as never } }));
  await setPerms(["PRODUCT_MANAGE", "MEMBER_POINTS"]);
  try {
    await open(page, "demo-staff@example.com");
    await expect(page.getByTestId("live-status")).toBeVisible();
    await expect(page.getByText("변경은 대표자만 할 수 있습니다")).toBeVisible();
    await expect(page.getByTestId("live-on-button")).toHaveCount(0);
    await expect(page.getByTestId("live-off")).toHaveCount(0);
  } finally {
    await setPerms(["PRODUCT_MANAGE"]);
  }
});

test("회원·적립금 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await open(page, "demo-none@example.com");
  await expect(page.getByText("필요한 권한: 회원·적립금", { exact: false })).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveCount(0);
});
