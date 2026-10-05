import { expect, test, type Page } from "@playwright/test";
import { INQUIRY_TITLES, clearInquiriesInDb, inquiryFromDb, seedInquiriesInDb } from "./buyerInquiryDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-046·047 구매자 문의: 문의 3건(답변 대기·비공개·답변 완료)을 만들어 두고 목록 필터, 답변 저장·지우기, 미저장 확인을 실제 API로 눌러 본다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
let made: Awaited<ReturnType<typeof seedInquiriesInDb>>;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  made = await seedInquiriesInDb(SLUG);
});
test.afterAll(() => clearInquiriesInDb(SLUG));

const login = async (page: Page, email: string) => {
  await page.goto("/seller/login?next=%2Fseller%2Fbuyer-inquiries");
  await submitSellerLogin(page, email, PASSWORD);
};
const row = (page: Page, title: string) => page.getByTestId("inquiry-row").filter({ hasText: title });

test("대표자: 목록·필터를 보고 답변을 저장·수정·지운다(저장 전에는 서버가 그대로)", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/buyer-inquiries$/);
  for (const t of Object.values(INQUIRY_TITLES)) await expect(row(page, t)).toHaveCount(1);
  await expect(row(page, INQUIRY_TITLES.waiting)).toContainText("상품 문의");
  await expect(row(page, INQUIRY_TITLES.waiting)).toContainText(made.productName);
  await expect(row(page, INQUIRY_TITLES.private)).toContainText("비공개");
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-046-inquiries-1440.png", fullPage: true });

  // 답변 대기 탭: 대기 문의만, 답변 완료 탭: 완료 문의만
  await page.getByRole("tab", { name: /^답변 대기/ }).click();
  await expect(row(page, INQUIRY_TITLES.answered)).toHaveCount(0);
  await expect(row(page, INQUIRY_TITLES.waiting)).toHaveCount(1);
  await page.getByRole("tab", { name: "답변 완료" }).click();
  await expect(row(page, INQUIRY_TITLES.waiting)).toHaveCount(0);
  await expect(row(page, INQUIRY_TITLES.answered)).toHaveCount(1);
  await page.getByRole("tab", { name: "전체" }).click();

  // 종류·검색어 필터
  await page.getByLabel("문의 종류").selectOption("GENERAL");
  await page.getByLabel("검색어").fill("문의e2e");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(row(page, INQUIRY_TITLES.waiting)).toHaveCount(0);
  await expect(row(page, INQUIRY_TITLES.private)).toHaveCount(1);
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(row(page, INQUIRY_TITLES.waiting)).toHaveCount(1);

  // 답변 쓰기: 쓰는 중에는 서버가 그대로, 저장하면 답변 완료
  await row(page, INQUIRY_TITLES.waiting).getByRole("button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("사이즈가 어떻게 되나요?");
  await expect(dialog.getByRole("button", { name: "답변 저장" })).toBeDisabled();
  await dialog.getByLabel("답변").fill("M 사이즈입니다");
  expect((await inquiryFromDb(SLUG, INQUIRY_TITLES.waiting)).status).toBe("WAITING");
  await dialog.getByRole("button", { name: "답변 저장" }).click();
  await expect(page.getByText("답변을 저장했습니다")).toBeVisible();
  await expect.poll(async () => inquiryFromDb(SLUG, INQUIRY_TITLES.waiting)).toEqual({ status: "ANSWERED", answer: "M 사이즈입니다" });

  // 쓰다 만 답변은 닫을 때 확인을 묻고, 계속 작성하면 입력이 남는다
  await dialog.getByLabel("답변").fill("L 사이즈도 있습니다");
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(page.getByText("저장하지 않은 변경이 있습니다")).toBeVisible();
  await page.getByRole("button", { name: "계속 작성" }).click();
  await expect(dialog.getByLabel("답변")).toHaveValue("L 사이즈도 있습니다");

  // 답변 지우기: 답변 대기로 돌아간다
  await dialog.getByRole("button", { name: "답변 지우기" }).click();
  await expect(page.getByText("답변을 지웠습니다. 답변 대기로 돌아갑니다")).toBeVisible();
  await expect.poll(async () => inquiryFromDb(SLUG, INQUIRY_TITLES.waiting)).toEqual({ status: "WAITING", answer: null });
});

test("구매자 문의 권한이 없는 직원: 목록은 보이고 답변 입력은 막힌다", async ({ page }) => {
  await login(page, "demo-staff@example.com");
  await expect(page).toHaveURL(/\/seller\/buyer-inquiries$/);
  await expect(page.getByText("문의 목록만 볼 수 있습니다")).toBeVisible();
  await row(page, INQUIRY_TITLES.waiting).getByRole("button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("답변")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "답변 저장" })).toHaveCount(0);
});
