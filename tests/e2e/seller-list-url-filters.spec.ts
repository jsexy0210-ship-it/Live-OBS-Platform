import { expect, test, type Page } from "@playwright/test";
import { INQUIRY_TITLES, clearInquiriesInDb, seedInquiriesInDb } from "./buyerInquiryDb";
import { submitSellerLogin } from "./sellerLogin";

// 파트너스 홈 「처리할 일」 링크용: 교환·반품(?status=REQUESTED)과 구매자 문의(?status=WAITING)가 URL 쿼리를 초기 조건으로 읽고, 바꾸면 URL도 따라간다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await seedInquiriesInDb(SLUG);
});
test.afterAll(() => clearInquiriesInDb(SLUG));

// 로그인 뒤 이동 주소(next)는 쿼리를 지우므로, 먼저 로그인하고 쿼리가 있는 주소를 직접 연다
const login = async (page: Page, target: string) => {
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.goto(target);
};
const row = (page: Page, title: string) => page.getByTestId("inquiry-row").filter({ hasText: title });

test("구매자 문의: ?status=WAITING으로 열면 답변 대기 탭이 켜지고, 탭을 바꾸면 URL이 따라간다", async ({ page }) => {
  await login(page, "/seller/buyer-inquiries?status=WAITING");
  await expect(page).toHaveURL(/\/seller\/buyer-inquiries\?status=WAITING$/);
  await expect(page.getByRole("tab", { name: /^답변 대기/ })).toHaveAttribute("aria-selected", "true");
  await expect(row(page, INQUIRY_TITLES.waiting)).toHaveCount(1);
  await expect(row(page, INQUIRY_TITLES.answered)).toHaveCount(0);

  await page.getByRole("tab", { name: "답변 완료" }).click();
  await expect(page).toHaveURL(/status=ANSWERED$/);
  await expect(row(page, INQUIRY_TITLES.answered)).toHaveCount(1);
  await page.getByRole("tab", { name: "전체" }).click();
  await expect(page).toHaveURL(/\/seller\/buyer-inquiries$/);
  await expect(row(page, INQUIRY_TITLES.waiting)).toHaveCount(1);
  await expect(row(page, INQUIRY_TITLES.answered)).toHaveCount(1);

  // 검색 조건도 URL에 남아 새로고침해도 유지된다. 틀린 상태 값은 전체로 본다
  await page.getByLabel("검색어").fill("문의e2e-비공개");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page).toHaveURL(/q=/);
  await page.reload();
  await expect(row(page, INQUIRY_TITLES.private)).toHaveCount(1);
  await expect(row(page, INQUIRY_TITLES.waiting)).toHaveCount(0);
  await page.goto("/seller/buyer-inquiries?status=NOPE");
  await expect(page.getByRole("tab", { name: "전체" })).toHaveAttribute("aria-selected", "true");
  await expect(row(page, INQUIRY_TITLES.waiting)).toHaveCount(1);
});

test("교환·반품: ?status=REQUESTED로 열면 접수 탭이 켜지고, 전체를 누르면 쿼리가 빠진다", async ({ page }) => {
  await login(page, "/seller/returns?status=REQUESTED");
  await expect(page).toHaveURL(/\/seller\/returns\?status=REQUESTED$/);
  await expect(page.getByRole("tab", { name: "접수" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "전체" }).click();
  await expect(page).toHaveURL(/\/seller\/returns$/);
  await expect(page.getByRole("tab", { name: "전체" })).toHaveAttribute("aria-selected", "true");
  await page.goto("/seller/returns?status=NOPE");
  await expect(page.getByRole("tab", { name: "전체" })).toHaveAttribute("aria-selected", "true");
});
