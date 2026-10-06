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
let originalPlanId: string | null | undefined;
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
    if (originalTrialEndsAt === undefined) {
      const seller = await db.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { trialEndsAt: true, planId: true } });
      originalTrialEndsAt = seller.trialEndsAt;
      originalPlanId = seller.planId;
    }
    await clearSubscription(db, sellerId);
    await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: new Date(Date.now() - 86_400_000), planId: originalPlanId ?? null } });
  });
}
test.afterAll(async () => {
  if (originalTrialEndsAt === undefined) return;
  await withDb(async (db, sellerId) => {
    await clearSubscription(db, sellerId);
    await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: originalTrialEndsAt, planId: originalPlanId ?? null } });
  });
});

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

  // 카드 등록 → 결제가 일어나므로 금액이 담긴 확인 창을 거쳐 바로 결제
  await page.getByRole("button", { name: "카드 등록하기" }).click();
  await expect(page.getByRole("dialog")).toContainText(/등록하면 바로 [\d,]+원을 결제/);
  const quoted = (await page.getByRole("dialog").textContent())!.match(/바로 ([\d,]+원)을/)![1];
  const card = post(page, "/api/seller/subscription/card");
  await page.getByRole("dialog").getByRole("button", { name: "카드 등록하기" }).click();
  expect((await card).status()).toBe(200);
  // 확인 창에 보인 금액이 실제 결제 금액과 같다
  await expect(page.getByTestId("sub-payment").first()).toContainText(quoted);
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
  await overlay.getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("다음 결제일부터 적용됩니다");
  const plan = post(page, "/api/seller/subscription/plan");
  await page.getByRole("dialog").getByRole("button", { name: "이용권 바꾸기", exact: true }).click();
  expect((await plan).status()).toBe(200);
  await expect(page.getByText("「오버레이 전용」으로 바뀝니다").first()).toBeVisible();
  await expect(page.getByRole("note").filter({ hasText: "바뀔 예정" })).toContainText("「오버레이 전용」으로 바뀝니다");
  await page.reload();
  await expect(overlay.getByRole("button", { name: "바꾸기 예정" })).toBeDisabled();
  await shot(page, "SA-090-subscription-active");

  // 예약 취소
  const undo = post(page, "/api/seller/subscription/plan");
  await page.getByRole("button", { name: "바꾸기 취소하기" }).click();
  const undoAsk = page.getByRole("dialog", { name: "이용권 바꾸기를 취소하시겠습니까?" });
  await expect(undoAsk).toContainText("바뀌는 예약이 없어지고 지금 이용권을 계속 씁니다");
  await undoAsk.getByRole("button", { name: "바꾸기 취소하기" }).click();
  expect((await undo).status()).toBe(200);
  await expect(page.getByText("이용권 바꾸기 예약을 취소했습니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "바꾸기 취소하기" })).toHaveCount(0);

  // 해지 → 이번 기간 끝까지 이용, 해지 예정으로 바뀐다
  await page.getByRole("button", { name: "구독 해지하기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("구독을 해지하시겠습니까?");
  const cancel = post(page, "/api/seller/subscription/cancel");
  await page.getByRole("dialog").getByRole("button", { name: "구독 해지하기", exact: true }).click();
  expect((await cancel).status()).toBe(200);
  await expect(page.getByTestId("sub-status")).toHaveText("해지 예정");
  await page.reload();
  await expect(page.getByTestId("sub-status")).toHaveText("해지 예정");
  await expect(page.getByRole("button", { name: "구독 해지하기", exact: true })).toHaveCount(0);
  // 해지 예정이면 플랜을 바꿀 수 없다(예약해도 해지로 끝나 적용되지 않는다)
  await expect(overlay.getByRole("button", { name: "바꾸기", exact: true })).toBeDisabled();
  await expect(page.getByText("해지 예정인 구독은 이용권을 바꿀 수 없습니다.")).toBeVisible();
  // 서버도 해지 예정 중 플랜 변경을 거절한다
  const blocked = await page.evaluate(async () => (await fetch("/api/seller/subscription/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planCode: "OVERLAY_ONLY" }) })).json());
  expect(blocked).toMatchObject({ error: "cancel_scheduled" });

  // 카드를 다시 등록하면 해지 예약이 풀린다: 말없이 풀리지 않게 확인 창을 거친다(결제한 기간 중이라 결제는 없음)
  await page.getByRole("button", { name: "카드 변경하기" }).click();
  await expect(page.getByRole("dialog")).toContainText("해지를 취소하고 자동결제가 다시 켜집니다.");
  await expect(page.getByRole("dialog")).not.toContainText("바로");
  const recard = post(page, "/api/seller/subscription/card");
  await page.getByRole("dialog").getByRole("button", { name: "카드 등록하기" }).click();
  expect((await recard).status()).toBe(200);
  await expect(page.getByTestId("sub-status")).toHaveText("이용 중");
  await expect(page.getByTestId("sub-payment")).toHaveCount(1);
});

test("거절된 카드는 실패로 알리고 카드를 등록한 것처럼 보이지 않는다", async ({ page }) => {
  await resetSubscription();
  await page.goto("/seller/login?next=%2Fseller%2Fsubscription");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page.getByTestId("sub-card-label")).toHaveText("등록된 카드가 없습니다");
  // 가짜 결제 공급자는 reject로 시작하는 인증 값을 거절한다. 화면이 보내는 값을 그렇게 바꿔 거절 응답을 받는다.
  await page.route("**/api/seller/subscription/card", (route) => route.continue({ postData: JSON.stringify({ authKey: "reject-e2e" }) }));
  const card = post(page, "/api/seller/subscription/card");
  await page.getByRole("button", { name: "카드 등록하기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "카드 등록하기" }).click();
  expect((await card).status()).toBe(402);
  await expect(page.getByRole("alert").filter({ hasText: "처리하지 못했습니다" })).toContainText("카드를 등록할 수 없습니다");
  await expect(page.getByTestId("sub-card-label")).toHaveText("등록된 카드가 없습니다");
  await expect(page.getByTestId("sub-status")).toHaveText("이용 기간 끝");
  // 결제한 기간이 없으면 하위 변경은 「다음 결제일부터」가 아니라 바로 적용·결제 없음으로 안내한다(서버 planChange와 같은 기준)
  await page.getByTestId("sub-plan").filter({ hasText: "오버레이 전용" }).getByRole("button", { name: "바꾸기", exact: true }).click();
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
  await page.getByTestId("sub-plan").filter({ hasText: "쇼핑몰 통합" }).getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("밀린 이번 기간 요금과 남은 기간 차액을 등록한 카드로 바로 결제합니다.");
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();

  // 이용 기간이 끝났어도 해지는 열려 있다(서버 cancelSubscription이 받는 상태)
  await page.getByRole("button", { name: "구독 해지하기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("바로 해지되고 더 이상 결제되지 않습니다.");
  const cancel = post(page, "/api/seller/subscription/cancel");
  await page.getByRole("dialog").getByRole("button", { name: "구독 해지하기", exact: true }).click();
  expect((await cancel).status()).toBe(200);
  await expect(page.getByRole("button", { name: "구독 해지하기", exact: true })).toHaveCount(0);
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
  await page.getByRole("button", { name: "카드 등록하기" }).click();
  await expect(page.getByRole("dialog")).toContainText("등록한 카드로 매달 자동 결제됩니다.");
  await page.getByRole("dialog").getByRole("button", { name: "카드 등록하기" }).click();
  expect((await card).status()).toBe(200);
  await expect(page.getByText("결제 카드를 등록했습니다")).toBeVisible();
  await expect(page.getByTestId("sub-payment")).toHaveCount(0);

  const endText = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(trialEnd).replace(/\.\s*/g, ".").replace(/\.$/, "");
  await page.getByRole("button", { name: "구독 해지하기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(`${endText}까지 이용할 수 있고`);
  const cancel = post(page, "/api/seller/subscription/cancel");
  await page.getByRole("dialog").getByRole("button", { name: "구독 해지하기", exact: true }).click();
  expect((await cancel).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId("sub-status")).toHaveText("해지 예정");
  await expect(page.getByText(`해지했습니다. ${endText}까지 이용할 수 있고, 그 뒤에는 결제되지 않습니다.`)).toBeVisible();

  // 체험 중 해지 뒤 카드 변경은 해지가 풀린다고 먼저 묻고, 취소하면 서버 상태가 그대로다
  let cardCalls = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/seller/subscription/card") && r.method() === "POST") cardCalls++;
  });
  await page.getByRole("button", { name: "카드 변경하기" }).click();
  await expect(page.getByRole("dialog")).toContainText("해지를 취소하고 자동결제가 다시 켜집니다.");
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(cardCalls).toBe(0);
  const after = await withDb((db, sellerId) => db.sellerSubscription.findUniqueOrThrow({ where: { sellerId }, select: { status: true } }));
  expect(after.status).toBe("CANCELED");
});

// 데모 쇼핑몰을 오버레이 전용 플랜으로 둔다(상위 변경 확인용)
const useOverlayPlan = () =>
  withDb(async (db, sellerId) => {
    const overlay = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    await db.seller.update({ where: { id: sellerId }, data: { planId: overlay.id } });
  });
const integratedCard = (page: Page) => page.getByTestId("sub-plan").filter({ hasText: "쇼핑몰 통합" });

test("결제한 기간 중 상위 변경: 남은 기간 차액을 바로 결제한다고 안내하고, 실제로 차액 결제 1건이 생긴다", async ({ page }) => {
  await resetSubscription();
  await useOverlayPlan();
  await ownerOpens(page);
  await page.getByRole("button", { name: "카드 등록하기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "카드 등록하기" }).click();
  await expect(page.getByTestId("sub-status")).toHaveText("이용 중");
  await expect(page.getByTestId("sub-payment")).toHaveCount(1);

  await integratedCard(page).getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("남은 이용 기간의 차액을 등록한 카드로 바로 결제합니다.");
  // 미리보기의 지금 낼 금액이 확인 창에 보이고, 변경 요청에 expectedAmount로 함께 간다
  await expect(page.getByTestId("sub-quote")).toContainText("지금 결제 금액");
  const quoted = Number(((await page.getByTestId("sub-quote").textContent()) ?? "").replace(/[^0-9]/g, ""));
  expect(quoted).toBeGreaterThan(0);
  const plan = post(page, "/api/seller/subscription/plan");
  await page.getByRole("dialog").getByRole("button", { name: "이용권 바꾸기", exact: true }).click();
  const planRes = await plan;
  expect(planRes.request().postDataJSON()).toEqual({ planCode: "INTEGRATED", expectedAmount: quoted });
  const body = await planRes.json();
  expect(body).toMatchObject({ ok: true, applied: "now", planCode: "INTEGRATED" });
  expect(body.charged).toBe(quoted);
  expect(body.charged).toBeGreaterThan(0);
  await expect(page.getByText(`「쇼핑몰 통합」으로 바꿨습니다 · 차액 ${body.charged.toLocaleString("ko-KR")}원 결제`)).toBeVisible();
  await expect(page.getByTestId("sub-payment")).toHaveCount(2);
  await expect(integratedCard(page).getByText("이용 중")).toBeVisible();
});

test("확인한 금액과 지금 낼 금액이 달라지면(409 amount_changed) 아무것도 바꾸지 않고 새 금액을 다시 보여 준다", async ({ page }) => {
  await resetSubscription();
  await useOverlayPlan();
  await ownerOpens(page);
  await page.getByRole("button", { name: "카드 등록하기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "카드 등록하기" }).click();
  await expect(page.getByTestId("sub-status")).toHaveText("이용 중");

  // 첫 변경 요청은 서버가 금액이 바뀌었다고 거절한다(아무것도 바뀌지 않음). 그 뒤 미리보기는 다른 금액을 준다.
  let posts = 0;
  const sent: unknown[] = [];
  await page.route("**/api/seller/subscription/plan", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push(route.request().postDataJSON());
    if (++posts === 1) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "amount_changed" }) });
    return route.continue();
  });
  let previews = 0;
  await page.route("**/api/seller/subscription/plan/preview", async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    if (++previews >= 2) for (const p of data.plans) if (p.change?.ok && p.change.chargeNow > 0) p.change.chargeNow += 1000;
    await route.fulfill({ response: res, json: data });
  });

  await integratedCard(page).getByRole("button", { name: "바꾸기", exact: true }).click();
  const quote = page.getByTestId("sub-quote");
  await expect(quote).toContainText("지금 결제 금액");
  const first = Number(((await quote.textContent()) ?? "").replace(/[^0-9]/g, ""));
  await page.getByRole("dialog").getByRole("button", { name: "이용권 바꾸기", exact: true }).click();

  // 창이 닫히지 않고, 금액이 바뀌었다는 안내와 새 금액이 보인다. 아직 변경되지 않았다.
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(quote).toContainText("금액이 바뀌었습니다. 다시 확인해 주십시오.");
  await expect.poll(async () => Number(((await quote.textContent()) ?? "").replace(/[^0-9]/g, ""))).toBe(first + 1000);
  await expect(page.getByTestId("sub-payment")).toHaveCount(1);
  expect(await withDb((db, sellerId) => db.sellerSubscription.findUniqueOrThrow({ where: { sellerId }, select: { plan: { select: { code: true } } } }))).toMatchObject({ plan: { code: "OVERLAY_ONLY" } });

  // 새 금액으로 다시 확인하면 그 금액을 expectedAmount로 보낸다
  await page.getByRole("dialog").getByRole("button", { name: "이용권 바꾸기", exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[0]).toEqual({ planCode: "INTEGRATED", expectedAmount: first });
  expect(sent[1]).toEqual({ planCode: "INTEGRATED", expectedAmount: first + 1000 });
});

test("체험 중 상위 변경: 카드가 없으면 막고, 카드를 등록하면 새 이용권 요금을 바로 결제한다", async ({ page }) => {
  await resetSubscription();
  await useOverlayPlan();
  await withDb((db, sellerId) => db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: new Date(Date.now() + 5 * 86_400_000) } }));
  await ownerOpens(page);
  await expect(page.getByTestId("sub-status")).toHaveText("체험 중");
  await integratedCard(page).getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("올리려면 결제 카드를 먼저 등록해 주십시오.");
  await expect(page.getByRole("dialog").getByRole("button", { name: "이용권 바꾸기", exact: true })).toBeDisabled();
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();

  // 체험 중 카드 등록은 결제가 없고, 확인 창에서 자동 결제 안내만 보인다
  await page.getByRole("button", { name: "카드 등록하기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "카드 등록하기" }).click();
  await expect(page.getByText("결제 카드를 등록했습니다")).toBeVisible();
  await integratedCard(page).getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("새 이용권 요금을 등록한 카드로 바로 결제하고, 오늘부터 새 이용 기간이 시작됩니다.");
  const plan = post(page, "/api/seller/subscription/plan");
  await page.getByRole("dialog").getByRole("button", { name: "이용권 바꾸기", exact: true }).click();
  expect(await (await plan).json()).toMatchObject({ ok: true, applied: "now", planCode: "INTEGRATED" });
  await expect(page.getByTestId("sub-payment")).toHaveCount(1);
  await expect(page.getByTestId("sub-status")).toHaveText("이용 중");
});

test("직원은 메뉴가 안 보이고, 주소로 들어와도 대표자 전용 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fsubscription");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/subscription$/);
  await expect(page.getByText("필요한 권한: 대표자", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "구독 · 결제", exact: true })).toHaveCount(0);
});
