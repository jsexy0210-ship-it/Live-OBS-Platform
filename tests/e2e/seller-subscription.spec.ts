import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-090 구독 · 결제: 테스트 서버(OBS_TEST_MODE=1, 가짜 결제 공급자·돈 이동 없음)에서
// 카드 등록·결제 → 하위 플랜 변경 예약·취소 → 해지를 실제 API로 눌러 확인한다.
// 서버는 OBS_TEST_MODE=1과 BILLING_KEY_SECRET(32자 이상 테스트용 임의값)을 넣고 띄운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

// 폐기용 테스트 DB에서 데모 대표자의 구독·결제 기록을 지우고 체험도 끝난 상태(첫 결제 전 잠김)로 맞춘다.
// 다른 e2e가 체험 중인 데모 쇼핑몰을 쓰므로 끝나면 구독을 지우고 원래 체험 종료 시각으로 되돌린다.
let originalTrialEndsAt: Date | null | undefined;
async function withDb<T>(fn: (db: PrismaClient, sellerId: string) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com", isOwner: true }, select: { sellerId: true } });
    return await fn(db, owner.sellerId);
  } finally {
    await db.$disconnect();
  }
}
const clearSubscription = (db: PrismaClient, sellerId: string) =>
  db.$transaction([db.subscriptionPayment.deleteMany({ where: { sellerId } }), db.sellerSubscription.deleteMany({ where: { sellerId } })]);
async function resetSubscription() {
  await withDb(async (db, sellerId) => {
    if (originalTrialEndsAt === undefined) originalTrialEndsAt = (await db.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { trialEndsAt: true } })).trialEndsAt;
    await clearSubscription(db, sellerId);
    await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: new Date(Date.now() - 86_400_000) } });
  });
}
test.afterAll(async () => {
  if (originalTrialEndsAt === undefined) return;
  await withDb(async (db, sellerId) => {
    await clearSubscription(db, sellerId);
    await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: originalTrialEndsAt } });
  });
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const post = (page: Page, path: string) => page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(path));

test("대표자: 카드 등록·결제, 하위 플랜 변경 예약과 취소, 해지가 서버에 반영된다", async ({ page }) => {
  await resetSubscription();
  await page.goto("/seller/login?next=%2Fseller%2Fsubscription");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/subscription$/);

  // 메뉴 「구독 · 결제」에서 들어온다
  await expect(page.getByRole("link", { name: "구독 · 결제", exact: true })).toHaveAttribute("href", "/seller/subscription");
  await expect(page.getByTestId("sub-status")).toHaveText("이용 기간 끝");
  await expect(page.getByTestId("sub-card-label")).toHaveText("등록된 카드가 없습니다");
  await expect(page.getByText("청구 내역이 없습니다")).toBeVisible();
  await expect(page.getByText("테스트 서버입니다. 실제 카드 등록과 결제는 이루어지지 않습니다.")).toBeVisible();
  await shot(page, "SA-090-subscription-empty");

  // 카드 등록 → 바로 결제
  const card = post(page, "/api/seller/subscription/card");
  await page.getByRole("button", { name: "테스트 카드 등록" }).click();
  expect((await card).status()).toBe(200);
  await expect(page.getByText("카드를 등록하고 결제했습니다")).toBeVisible();
  await expect(page.getByTestId("sub-status")).toHaveText("이용 중");
  await expect(page.getByTestId("sub-card-label")).toHaveText("테스트카드 1234");
  await expect(page.getByTestId("sub-payment")).toHaveCount(1);
  await expect(page.getByTestId("sub-payment").first()).toContainText("결제 완료");
  await expect(page.getByText("다음 결제", { exact: true })).toBeVisible();
  // 상단 이용 상태 띠도 새로 읽어 잠금 안내가 사라진다
  await expect(page.getByText("이용 기간이 끝났습니다")).toHaveCount(0);

  // 하위 플랜(오버레이 전용)으로 변경 → 다음 결제일부터 적용 예약
  const overlay = page.getByTestId("sub-plan").filter({ hasText: "오버레이 전용" });
  await overlay.getByRole("button", { name: "변경" }).click();
  await expect(page.getByRole("dialog")).toContainText("다음 결제일부터 적용됩니다");
  const plan = post(page, "/api/seller/subscription/plan");
  await page.getByRole("dialog").getByRole("button", { name: "변경", exact: true }).click();
  expect((await plan).status()).toBe(200);
  await expect(page.getByText("「오버레이 전용」으로 변경됩니다")).toBeVisible();
  await expect(page.getByRole("note").filter({ hasText: "변경 예정" })).toContainText("「오버레이 전용」으로 바뀝니다");
  await page.reload();
  await expect(overlay.getByRole("button", { name: "변경 예정" })).toBeDisabled();
  await shot(page, "SA-090-subscription-active");

  // 예약 취소
  const undo = post(page, "/api/seller/subscription/plan");
  await page.getByRole("button", { name: "변경 취소" }).click();
  expect((await undo).status()).toBe(200);
  await expect(page.getByText("플랜 변경 예약을 취소했습니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "변경 취소" })).toHaveCount(0);

  // 해지 → 이번 기간 끝까지 이용, 해지 예정으로 바뀐다
  await page.getByRole("button", { name: "해지", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("구독을 해지하시겠습니까?");
  const cancel = post(page, "/api/seller/subscription/cancel");
  await page.getByRole("dialog").getByRole("button", { name: "해지", exact: true }).click();
  expect((await cancel).status()).toBe(200);
  await expect(page.getByTestId("sub-status")).toHaveText("해지 예정");
  await page.reload();
  await expect(page.getByTestId("sub-status")).toHaveText("해지 예정");
  await expect(page.getByRole("button", { name: "해지", exact: true })).toHaveCount(0);
  // 해지 예정이면 플랜을 바꿀 수 없다(예약해도 해지로 끝나 적용되지 않는다)
  await expect(overlay.getByRole("button", { name: "변경" })).toBeDisabled();
  await expect(page.getByText("해지 예정인 구독은 플랜을 바꿀 수 없습니다.")).toBeVisible();
});

test("거절된 카드는 실패로 알리고 카드를 등록한 것처럼 보이지 않는다", async ({ page }) => {
  await resetSubscription();
  await page.goto("/seller/login?next=%2Fseller%2Fsubscription");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page.getByTestId("sub-card-label")).toHaveText("등록된 카드가 없습니다");
  // 가짜 결제 공급자는 reject로 시작하는 인증 값을 거절한다. 화면이 보내는 값을 그렇게 바꿔 거절 응답을 받는다.
  await page.route("**/api/seller/subscription/card", (route) => route.continue({ postData: JSON.stringify({ authKey: "reject-e2e" }) }));
  const card = post(page, "/api/seller/subscription/card");
  await page.getByRole("button", { name: "테스트 카드 등록" }).click();
  expect((await card).status()).toBe(402);
  await expect(page.getByRole("alert").filter({ hasText: "처리하지 못했습니다" })).toContainText("카드를 등록할 수 없습니다");
  await expect(page.getByTestId("sub-card-label")).toHaveText("등록된 카드가 없습니다");
  await expect(page.getByTestId("sub-status")).toHaveText("이용 기간 끝");
  // 결제한 기간이 없으면 하위 변경은 「다음 결제일부터」가 아니라 바로 적용·결제 없음으로 안내한다(서버 planChange와 같은 기준)
  await page.getByTestId("sub-plan").filter({ hasText: "오버레이 전용" }).getByRole("button", { name: "변경" }).click();
  await expect(page.getByRole("dialog")).toContainText("바로 적용됩니다. 결제는 없습니다.");
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();
});

async function ownerOpens(page: Page) {
  await page.goto("/seller/login?next=%2Fseller%2Fsubscription");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/subscription$/);
}

test("유예가 끝난 결제 실패 구독: 상위 변경은 지금 결제된다고 안내하고, 해지할 수 있다", async ({ page }) => {
  await resetSubscription();
  // 오버레이 전용 · 결제 실패(PAST_DUE) · 유예와 결제한 기간 모두 끝남(잠김). 서버 changePlan은 이 상태의 상위 변경을 바로 결제한다.
  await withDb(async (db, sellerId) => {
    const overlay = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    const day = 86_400_000;
    await db.sellerSubscription.create({
      data: {
        sellerId,
        planId: overlay.id,
        status: "PAST_DUE",
        cardLabel: "테스트카드 1234",
        currentPeriodStart: new Date(Date.now() - 40 * day),
        currentPeriodEnd: new Date(Date.now() - 10 * day),
        graceUntil: new Date(Date.now() - 3 * day),
        retryCount: 3,
      },
    });
  });
  await ownerOpens(page);
  await expect(page.getByTestId("sub-status")).toHaveText("이용 기간 끝");
  await page.getByTestId("sub-plan").filter({ hasText: "쇼핑몰 통합" }).getByRole("button", { name: "변경" }).click();
  await expect(page.getByRole("dialog")).toContainText("밀린 이번 기간 요금과 남은 기간 차액을 등록한 카드로 바로 결제합니다.");
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();

  // 이용 기간이 끝났어도 해지는 열려 있다(서버 cancelSubscription이 받는 상태)
  await page.getByRole("button", { name: "해지", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("바로 해지되고 더 이상 결제되지 않습니다.");
  const cancel = post(page, "/api/seller/subscription/cancel");
  await page.getByRole("dialog").getByRole("button", { name: "해지", exact: true }).click();
  expect((await cancel).status()).toBe(200);
  await expect(page.getByRole("button", { name: "해지", exact: true })).toHaveCount(0);
  const status = await withDb((db, sellerId) => db.sellerSubscription.findUniqueOrThrow({ where: { sellerId }, select: { status: true } }));
  expect(status.status).toBe("CANCELED");
});

test("카드를 등록한 체험을 해지하면 체험 끝 날짜까지 해지 예정으로 보인다", async ({ page }) => {
  await resetSubscription();
  const trialEnd = new Date(Date.now() + 5 * 86_400_000);
  await withDb((db, sellerId) => db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: trialEnd } }));
  await ownerOpens(page);
  await expect(page.getByTestId("sub-status")).toHaveText("체험 중");
  // 체험 중 카드 등록은 결제 없이 카드만 저장한다
  const card = post(page, "/api/seller/subscription/card");
  await page.getByRole("button", { name: "테스트 카드 등록" }).click();
  expect((await card).status()).toBe(200);
  await expect(page.getByText("결제 카드를 등록했습니다")).toBeVisible();
  await expect(page.getByTestId("sub-payment")).toHaveCount(0);

  const endText = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(trialEnd);
  await page.getByRole("button", { name: "해지", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(`${endText}까지 이용할 수 있고`);
  const cancel = post(page, "/api/seller/subscription/cancel");
  await page.getByRole("dialog").getByRole("button", { name: "해지", exact: true }).click();
  expect((await cancel).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId("sub-status")).toHaveText("해지 예정");
  await expect(page.getByText(`해지했습니다. ${endText}까지 이용할 수 있고, 그 뒤에는 결제되지 않습니다.`)).toBeVisible();
});

test("직원은 메뉴가 안 보이고, 주소로 들어와도 대표자 전용 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fsubscription");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/subscription$/);
  await expect(page.getByText("필요한 권한: 대표자", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "구독 · 결제", exact: true })).toHaveCount(0);
});
