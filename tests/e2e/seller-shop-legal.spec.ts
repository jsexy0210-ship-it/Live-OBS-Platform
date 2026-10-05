import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-062 법정 고지·약관(쇼핑몰 이용약관·개인정보처리방침 입력): 게시 조건 검사, 저장하면 구매자 화면(/shop/demo-shop/terms)에 글자 그대로 표시.
// 폐기용 테스트 DB(이름이 _test로 끝남)의 데모 쇼핑몰(demo-shop)을 쓰고, 시험이 만든 글은 끝나면 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const db = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

async function cleanup() {
  const c = db();
  try {
    const shop = await c.seller.findUnique({ where: { slug: SLUG }, select: { id: true } });
    if (shop) await c.shopLegalDoc.deleteMany({ where: { sellerId: shop.id } });
  } finally {
    await c.$disconnect();
  }
}
test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await cleanup();
});
test.afterAll(cleanup);

async function login(page: Page, next: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

test("게시하려면 시행일·본문이 필요하고, 저장하면 구매자 화면에 글자 그대로 표시된다", async ({ page, context }) => {
  await login(page, "/seller/settings/legal");
  await expect(page.getByRole("heading", { name: "법정 고지 · 약관" })).toBeVisible();
  await expect(page.getByTestId("legal-status-terms")).toContainText("게시 전");
  await expect(page.getByTestId("legal-save-terms")).toBeDisabled(); // 바뀐 것이 없으면 저장 못 함

  // 게시를 켜고 비워 둔 채 저장하면 칸 가까이에 이유가 나온다
  await page.getByRole("switch", { name: "이용약관 구매자에게 게시" }).click();
  await page.getByTestId("legal-save-terms").click();
  await expect(page.getByText("게시하려면 본문을 입력해 주십시오")).toBeVisible();
  await expect(page.getByText("게시하려면 시행일을 입력해 주십시오")).toBeVisible();

  await page.getByLabel("이용약관 본문").fill("제1조(목적)\n이 약관은 <b>시험</b> 쇼핑몰 이용 조건이에요.");
  await page.getByLabel("이용약관 시행일").fill("2026-11-01");
  await page.getByTestId("legal-save-terms").click();
  await expect(page.getByTestId("legal-status-terms")).toContainText("게시 중 · 시행일 2026년 11월 1일");
  await expect(page.getByTestId("legal-save-terms")).toBeDisabled();

  // 구매자 화면: 본문이 텍스트로만 보이고 시행일이 보인다. 개인정보처리방침은 아직 준비 중
  const buyer = await context.newPage();
  await buyer.goto(`/shop/${SLUG}/terms`);
  await expect(buyer.getByTestId("shop-legal-body")).toContainText("<b>시험</b>");
  await expect(buyer.getByText("시행일 2026년 11월 1일")).toBeVisible();
  await buyer.goto(`/shop/${SLUG}/privacy`);
  await expect(buyer.getByRole("heading", { level: 1 })).toHaveText("개인정보처리방침을 준비하고 있어요");

  // 게시를 끄고 저장하면 구매자 화면은 다시 준비 중
  await page.getByRole("switch", { name: "이용약관 구매자에게 게시" }).click();
  await page.getByTestId("legal-save-terms").click();
  await expect(page.getByTestId("legal-status-terms")).toContainText("게시 전");
  await buyer.goto(`/shop/${SLUG}/terms`);
  await expect(buyer.getByRole("heading", { level: 1 })).toHaveText("이용약관을 준비하고 있어요");
});

test("탭을 옮겨도 입력 중인 내용이 남는다", async ({ page }) => {
  await login(page, "/seller/settings/legal");
  await page.getByLabel("이용약관 본문").fill("입력 중인 약관");
  await page.getByRole("tab", { name: "개인정보처리방침" }).click();
  await expect(page.getByLabel("개인정보처리방침 본문")).toBeVisible();
  await page.getByRole("tab", { name: "이용약관" }).click();
  await expect(page.getByLabel("이용약관 본문")).toHaveValue("입력 중인 약관");
});
