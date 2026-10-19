import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { createBuyer, createSeller, db } from "../integration/helpers";

// 보드 SH-041 v320: 잠금 화면(로그인 전 「로그인하기」 · 로그인 후 「주문 조회」「문의하기」).
// 폐기용 DB의 독립 쇼핑몰: ACTIVE·OPEN·통합 이용권이지만 체험 만료·구독 없음. 운영 일시 정지(SH-040)와 구분한다.
let SLUG: string;
let LOGIN: string;
let ownedSellerId: string | undefined;
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  const { seller, grade } = await createSeller();
  ownedSellerId = seller.id;
  SLUG = seller.slug;
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
  await db.seller.update({ where: { id: seller.id }, data: { status: "ACTIVE", operatingState: "OPEN", planId: plan.id, trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
  expect(await db.sellerSubscription.count({ where: { sellerId: seller.id } })).toBe(0);
  const buyer = await createBuyer(seller.id, grade.id);
  LOGIN = `${buyer.loginId}@example.com`;
  await db.buyerMember.update({ where: { id: buyer.id }, data: { loginId: LOGIN, passwordHash: await hashPassword(PASSWORD) } });
});
test.afterAll(async () => {
  try {
    if (!ownedSellerId) return;
    await db.$transaction([
      db.buyerSession.deleteMany({ where: { sellerId: ownedSellerId } }),
      db.auditLog.deleteMany({ where: { sellerId: ownedSellerId } }),
      db.buyerMember.deleteMany({ where: { sellerId: ownedSellerId } }),
      db.memberGrade.deleteMany({ where: { sellerId: ownedSellerId } }),
      db.seller.delete({ where: { id: ownedSellerId } }),
    ]);
  } finally {
    await db.$disconnect();
  }
});

async function shot(page: Page, name: string) {
  for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: `tests/e2e/screenshots/SH-041-${name}-${w}.png` });
  }
}

test("로그인 전: 로그인하기", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/products`);
  const card = page.locator(".shop-locked");
  await expect(card.getByRole("heading", { name: "지금은 쇼핑몰을 이용할 수 없어요", level: 1 })).toBeVisible();
  await expect(card).toContainText("이미 주문한 내역은 확인할 수 있어요.");
  await expect(card.getByRole("link", { name: "로그인하기" })).toBeVisible();
  await expect(card.getByRole("link", { name: "문의하기" })).toHaveCount(0);
  await shot(page, "out");
});

test("로그인 후: 주문 조회 · 문의하기", async ({ page, baseURL }) => {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  await page.goto(`/shop/${SLUG}/products`);
  const card = page.locator(".shop-locked");
  await expect(card.getByRole("link", { name: "주문 조회" })).toBeVisible();
  await expect(card.getByRole("link", { name: "문의하기" })).toHaveAttribute("href", `/shop/${SLUG}/me/inquiries`);
  await expect(card.getByRole("link", { name: "로그인하기" })).toHaveCount(0);
  await shot(page, "in");
});
