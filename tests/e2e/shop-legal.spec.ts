import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 쇼핑몰별 이용약관·개인정보처리방침(구매자 /shop/[슬러그]/terms·privacy): 게시 전 준비 중 안내, 게시하면 본문(텍스트로만)·시행일, 바닥글 링크.
// 쇼핑몰은 폐기용 시험 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const run = randomBytes(4).toString("hex");
const slug = `legal-e2e-${run}`;
let db: PrismaClient;
let sellerId: string;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const seller = await db.seller.create({ data: { slug, shopName: "약관 시험 쇼핑몰", status: "ACTIVE", trialEndsAt: new Date("2999-12-31T00:00:00Z") } });
  sellerId = seller.id;
});
test.afterAll(async () => {
  await db.shopLegalDoc.deleteMany({ where: { sellerId } });
  await db.$disconnect();
});

test("게시 전에는 준비 중 안내, 바닥글에 두 링크가 있다", async ({ page }) => {
  await page.goto(`/shop/${slug}/terms`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("이용약관을 준비하고 있어요");
  await expect(page.getByTestId("shop-legal")).toHaveCount(0);
  const foot = page.locator(".shop-foot");
  await expect(foot.getByRole("link", { name: "이용약관" })).toHaveAttribute("href", `/shop/${slug}/terms`);
  await expect(foot.getByRole("link", { name: "개인정보처리방침" })).toHaveAttribute("href", `/shop/${slug}/privacy`);
  await foot.getByRole("link", { name: "개인정보처리방침" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("개인정보처리방침을 준비하고 있어요");
});

test("게시하면 본문이 텍스트로만 보이고 시행일이 보인다", async ({ page }) => {
  await db.shopLegalDoc.create({
    data: { sellerId, kind: "TERMS", body: "제1조(목적)\n<b>굵게 아님</b> <script>window.__x=1</script>\n제2조", effectiveOn: new Date("2026-11-01T00:00:00Z"), isPublished: true, publishedAt: new Date(), version: 1 },
  });
  await page.goto(`/shop/${slug}/terms`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("이용약관");
  await expect(page.getByText("시행일 2026년 11월 1일")).toBeVisible();
  const body = page.getByTestId("shop-legal-body");
  await expect(body).toContainText("<b>굵게 아님</b>");
  await expect(body).toContainText("제2조");
  expect(await page.locator("[data-testid=shop-legal-body] b").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();
  // 다른 종류는 아직 준비 중
  await page.goto(`/shop/${slug}/privacy`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("개인정보처리방침을 준비하고 있어요");
});

test("없는 쇼핑몰은 404", async ({ page }) => {
  expect((await page.goto(`/shop/no-such-shop-${run}/terms`))?.status()).toBe(404);
});
