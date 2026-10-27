import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 공통 모달 동작은 현재 모달을 쓰는 환불 상세의 거절 사유 창에서 확인한다(제출하지 않는다).
// 발송 단가는 상세 폼으로 이동했으며 실제 저장·DB 반영은 admin-message-fees.spec.ts가 검증한다.
// X(닫기)·Esc·바깥 클릭=취소, 열면 첫 입력으로 포커스·닫으면 연 버튼으로 복귀, Tab이 모달 밖으로 나가지 않음, 배경 스크롤 차단,
// 값을 바꾼 뒤에는 닫는 방법과 관계없이 같은 미저장 확인, X 크기·위치·모서리. 계정은 폐기용 테스트 DB에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `modal-super-${run}@example.com`;
let db: PrismaClient;
let sellerId: string;
let subscriptionId: string;
let paymentId: string;
let refundId: string;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "대표", role: "SUPER_ADMIN" } });
  const seller = await db.seller.create({ data: { slug: `modal-${run}`, shopName: `모달 시험 ${run}`, status: "ACTIVE", approvedAt: new Date() } });
  sellerId = seller.id;
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
  const subscription = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id } });
  subscriptionId = subscription.id;
  const start = new Date();
  const payment = await db.subscriptionPayment.create({ data: { sellerId: seller.id, subscriptionId: subscription.id, amount: 199_000, status: "PAID", periodStart: start, periodEnd: new Date(start.getTime() + 30 * 86_400_000), providerPaymentId: `fake-modal-${run}`, paidAt: start } });
  paymentId = payment.id;
  const refund = await db.subscriptionRefund.create({ data: { sellerId: seller.id, paymentId: payment.id, amount: 199_000, source: "ADMIN", reason: "공통 모달 취소 시험" } });
  refundId = refund.id;
});
test.afterAll(async () => {
  try {
    if (refundId) await db.subscriptionRefund.delete({ where: { id: refundId } });
    if (paymentId) await db.subscriptionPayment.delete({ where: { id: paymentId } });
    if (subscriptionId) await db.sellerSubscription.delete({ where: { id: subscriptionId } });
    if (sellerId) await db.seller.delete({ where: { id: sellerId } });
  } finally {
    await db?.$disconnect();
  }
});

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto(`/admin/billing/refunds/${refundId}`);
  await expect(page.getByTestId("refund-status")).toContainText("승인 대기");
}

const opener = (page: Page) => page.locator("main").getByRole("button", { name: "거절", exact: true });
const refundState = () => db.subscriptionRefund.findUniqueOrThrow({ where: { id: refundId }, select: { status: true, amount: true, decisionNote: true, version: true, payment: { select: { status: true, amount: true } } } });

test("X·Esc·바깥 클릭은 취소와 같고, 포커스는 첫 입력으로 갔다가 연 버튼으로 돌아온다", async ({ page }) => {
  await open(page, 1440);
  const before = await refundState();
  const dialog = page.getByRole("dialog");

  await opener(page).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("거절 사유")).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

  // X: 오른쪽 위, 조작 영역 44px, 모서리 8px, 접근성 이름 「닫기」
  const x = dialog.getByRole("button", { name: "닫기", exact: true });
  const [xb, mb] = [await x.boundingBox(), await dialog.boundingBox()];
  expect(xb && mb && Math.round(mb.x + mb.width - (xb.x + xb.width))).toBe(12);
  expect(xb && mb && Math.round(xb.y - mb.y)).toBe(12);
  expect([Math.round(xb!.width), Math.round(xb!.height)]).toEqual([44, 44]);
  expect(await dialog.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe("16px");
  await x.click();
  await expect(dialog).toHaveCount(0);
  await expect(opener(page)).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

  await opener(page).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await opener(page).click();
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);

  // Tab·Shift+Tab은 모달 안에서만 돈다
  await opener(page).click();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((e) => e.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((e) => e.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await refundState()).toEqual(before);
});

test("값을 바꾸면 X·Esc·바깥 클릭·취소 모두 같은 미저장 확인을 거치고, 계속 작성하면 값이 남는다", async ({ page }) => {
  await open(page, 1440);
  const dialog = page.getByRole("dialog");
  const before = await refundState();

  await opener(page).click();
  await dialog.getByLabel("거절 사유").fill("취소할 시험 사유");
  const confirm = dialog.getByRole("alert").filter({ hasText: "저장하지 않은 변경이 있습니다" });

  for (const close of [
    () => dialog.getByRole("button", { name: "닫기", exact: true }).click(),
    () => page.keyboard.press("Escape"),
    () => page.mouse.click(5, 5),
    () => dialog.getByRole("button", { name: "취소" }).click(),
  ]) {
    await close();
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("button", { name: "계속 작성" })).toBeFocused();
    await confirm.getByRole("button", { name: "계속 작성" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(dialog.getByLabel("거절 사유")).toHaveValue("취소할 시험 사유");
    await expect(dialog.getByLabel("거절 사유")).toBeFocused();
  }
  // 확인이 떠 있을 때 Esc는 확인만 거두고 모달은 남는다
  await page.keyboard.press("Escape");
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(dialog.getByLabel("거절 사유")).toHaveValue("취소할 시험 사유");
  // 확인에서 「닫기」를 고르면 저장 없이 닫힌다
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await confirm.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await refundState()).toEqual(before);
});

test("휴대폰 폭에서도 모달이 화면 안에 들어오고 가로 넘침이 없다", async ({ page }) => {
  await open(page, 360);
  const before = await refundState();
  await opener(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  const { sw, cw } = await dialog.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
  // 실제 입력은 textarea이며 공통 textarea 최소 높이(96px)·모바일 조작 영역을 유지한다.
  expect(await dialog.getByLabel("거절 사유").evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(96);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await refundState()).toEqual(before);
});
