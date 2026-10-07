import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-062 법정 고지·약관(쇼핑몰 이용약관·개인정보처리방침 입력): 게시 조건 검사, 저장하면 구매자 화면(/shop/demo-shop/terms)에 글자 그대로 표시.
// 「사업자 정보·고지」 탭: 입력한 주소·고객센터·구매안전서비스·미성년자 안내가 구매자 바닥글에 표시된다.
// 폐기용 테스트 DB(이름이 _test로 끝남)의 데모 쇼핑몰(demo-shop)을 쓰고, 시험이 만든 글·넣은 사업자 정보는 끝나면 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const db = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

let originalBusinessInfo: unknown = null;
const BUSINESS = { companyName: "별빛상사", representativeName: "홍길동", businessNumber: "1234567890", mailOrderNumber: "2026-서울-0001" };

async function cleanup(restore = false) {
  const c = db();
  try {
    const shop = await c.seller.findUnique({ where: { slug: SLUG }, select: { id: true } });
    if (!shop) return;
    await c.shopLegalDoc.deleteMany({ where: { sellerId: shop.id } });
    await c.shopLegalNotice.deleteMany({ where: { sellerId: shop.id } });
    if (restore) await c.seller.update({ where: { id: shop.id }, data: { businessInfo: originalBusinessInfo === null ? Prisma.DbNull : (originalBusinessInfo as Prisma.InputJsonValue) } });
  } finally {
    await c.$disconnect();
  }
}
test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await cleanup();
  const c = db();
  try {
    const shop = await c.seller.findUniqueOrThrow({ where: { slug: SLUG }, select: { id: true, businessInfo: true } });
    originalBusinessInfo = shop.businessInfo;
    await c.seller.update({ where: { id: shop.id }, data: { businessInfo: BUSINESS } });
  } finally {
    await c.$disconnect();
  }
});
test.afterAll(() => cleanup(true));

async function login(page: Page, next: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

test("게시하려면 시행일·본문이 필요하고, 저장하면 구매자 화면에 글자 그대로 표시된다", async ({ page, context }) => {
  await login(page, "/seller/settings/legal");
  await expect(page.getByRole("heading", { name: "법정 고지 · 약관" })).toBeVisible();
  await expect(page.getByTestId("legal-status-terms")).toContainText("아직 공개 안 함");
  await expect(page.getByTestId("legal-save-terms")).toBeDisabled(); // 바뀐 것이 없으면 저장 못 함

  // 게시를 켜고 비워 둔 채 저장하면 칸 가까이에 이유가 나온다
  const publishTerms = page.getByRole("checkbox", { name: "이용약관 구매자에게 공개" });
  await expect(publishTerms).not.toBeChecked();
  await publishTerms.check();
  await page.getByTestId("legal-save-terms").click();
  await expect(page.getByText("공개하려면 본문을 써 주십시오")).toBeVisible();
  await expect(page.getByText("공개하려면 시작하는 날을 정해 주십시오")).toBeVisible();

  await page.getByLabel("이용약관 본문").fill("제1조(목적)\n이 약관은 <b>시험</b> 쇼핑몰 이용 조건이에요.");
  await page.getByLabel("이용약관 시작하는 날").fill("2026-11-01");
  await page.getByTestId("legal-save-terms").click();
  await expect(page.getByTestId("legal-status-terms")).toContainText("공개 중 · 시작하는 날 2026년 11월 1일");
  await expect(page.getByTestId("legal-save-terms")).toBeDisabled();

  // 구매자 화면: 본문이 텍스트로만 보이고 시행일이 보인다. 개인정보처리방침은 아직 준비 중
  const buyer = await context.newPage();
  await buyer.goto(`/shop/${SLUG}/terms`);
  await expect(buyer.getByTestId("shop-legal-body")).toContainText("<b>시험</b>");
  await expect(buyer.getByText("시행일 2026년 11월 1일")).toBeVisible();
  await buyer.goto(`/shop/${SLUG}/privacy`);
  await expect(buyer.getByRole("heading", { level: 1 })).toHaveText("개인정보처리방침을 준비하고 있어요");

  // 게시를 끄고 저장하면 구매자 화면은 다시 준비 중
  await publishTerms.uncheck();
  await page.getByTestId("legal-save-terms").click();
  await expect(page.getByTestId("legal-status-terms")).toContainText("아직 공개 안 함");
  await buyer.goto(`/shop/${SLUG}/terms`);
  await expect(buyer.getByRole("heading", { level: 1 })).toHaveText("이용약관을 준비하고 있어요");
});

test("사이드 메뉴로 문서를 바꿔도 입력 중인 내용이 남는다", async ({ page }) => {
  await login(page, "/seller/settings/legal");
  const menu = page.getByRole("complementary", { name: "파트너스 메뉴" });
  const confirmDirtyNavigation = () => page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("저장하지 않은 변경");
    await dialog.accept();
  });
  await page.getByLabel("이용약관 본문").fill("입력 중인 약관");
  confirmDirtyNavigation();
  await menu.getByRole("link", { name: "개인정보처리방침", exact: true }).click();
  await expect(page).toHaveURL(/section=privacy/);
  await expect(page.getByLabel("개인정보처리방침 본문")).toBeVisible();
  confirmDirtyNavigation();
  await menu.getByRole("link", { name: "이용약관", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("section") === "terms");
  await expect(page.getByLabel("이용약관 본문")).toHaveValue("입력 중인 약관");
});

test("사업자 정보·고지: 검사 오류가 칸 가까이에 보이고, 저장하면 구매자 바닥글에 입력한 항목만 표시된다", async ({ page, context }) => {
  await login(page, "/seller/settings/legal");
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "사업자정보 고지", exact: true }).click();
  // 입점 신청 때 받은 값은 읽기 전용으로 보인다
  await expect(page.getByTestId("legal-biz")).toContainText("별빛상사");
  await expect(page.getByTestId("legal-biz")).toContainText("123-45-67890");
  await expect(page.getByTestId("legal-save-notice")).toBeDisabled();

  // 틀린 값은 칸 가까이에 이유가 나온다
  await page.getByLabel("고객센터 전화").fill("전화번호");
  await page.getByRole("radio", { name: "에스크로" }).click();
  await page.getByLabel("확인 주소").fill("http://pay.example.com");
  await page.getByTestId("legal-save-notice").click();
  await expect(page.getByText("전화번호는 숫자·하이픈·괄호만 입력할 수 있습니다")).toBeVisible();
  await expect(page.getByText("가입한 업체 이름을 입력해 주십시오")).toBeVisible();
  await expect(page.getByText("확인 주소는 https://로 시작하는 주소만 쓸 수 있습니다")).toBeVisible();

  await page.getByLabel("주소", { exact: true }).fill("서울시 중구 세종대로 1 <b>3층</b>");
  await page.getByLabel("고객센터 전화").fill("1588-1234");
  await page.getByLabel("운영시간").fill("평일 10:00~17:00");
  await page.getByLabel("가입한 업체").fill("시험결제");
  await page.getByLabel("확인 주소").fill("https://pay.example.com/escrow");
  await page.getByLabel("미성년자 구매 안내").fill("미성년자는 법정대리인 동의가 필요해요.\n안내 글은 파트너스가 입력해요.");
  await page.getByTestId("legal-save-notice").click();
  await expect(page.getByTestId("legal-save-notice")).toBeDisabled();

  // 구매자 바닥글: 입력한 항목만, 값은 텍스트로만, 링크는 새 창
  const buyer = await context.newPage();
  await buyer.goto(`/shop/${SLUG}/terms`);
  const foot = buyer.locator(".shop-foot");
  await expect(foot).toContainText("서울시 중구 세종대로 1 <b>3층</b>");
  expect(await foot.locator("b").count()).toBe(0);
  await expect(foot).toContainText("1588-1234 · 평일 10:00~17:00");
  await expect(foot).not.toContainText("이메일"); // 입력하지 않은 항목은 줄을 뺀다
  await expect(foot).toContainText("호스팅 제공");
  await expect(foot.getByRole("link", { name: "확인하기" })).toHaveAttribute("href", "https://www.ftc.go.kr/bizCommPop.do?wrkr_no=1234567890");
  await expect(foot.getByRole("link", { name: "에스크로 가입(결제한 돈을 안전하게 보관해 주는 서비스) · 시험결제" })).toHaveAttribute("href", "https://pay.example.com/escrow");
  await expect(foot.getByRole("link", { name: "에스크로 가입(결제한 돈을 안전하게 보관해 주는 서비스) · 시험결제" })).toHaveAttribute("target", "_blank");
  await expect(buyer.getByTestId("shop-foot-minor")).toContainText("법정대리인 동의가 필요해요.");
  // 기존 검증 값 4개는 그대로 보인다
  await expect(foot).toContainText("별빛상사");
  await expect(foot).toContainText("123-45-67890");
  await expect(foot).toContainText("2026-서울-0001");
});
