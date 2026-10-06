import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// UX 감사 9.3: 배송·환불 요청·리뷰 목록이 탭·필터를 주소(쿼리)로 보존하고, 상세에서 Back으로 돌아오면 조건과 스크롤을 되찾는다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

const login = async (page: Page) => {
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/products$/);
};

test("배송: 탭·검색어가 주소에 남고, 주문 상세에서 Back으로 돌아오면 조건과 스크롤이 복원된다", async ({ page }) => {
  await login(page);
  await page.goto("/seller/shipping");
  await expect(page.getByTestId("shipment-row").first()).toBeVisible();

  await page.getByRole("button", { name: "배송 완료" }).click();
  await expect(page).toHaveURL(/\/seller\/shipping\?tab=delivered$/);
  await page.getByRole("button", { name: "발송 대기" }).click();
  await expect(page).toHaveURL(/\/seller\/shipping$/);
  await page.goto("/seller/shipping?tab=NOPE");
  await expect(page.getByRole("button", { name: "발송 대기" })).toHaveAttribute("aria-pressed", "true");

  // 검색어: 입력하면 주소에 남고 새로고침해도 유지된다
  await page.getByLabel("배송 검색").fill("존재하지않는닉네임");
  await expect(page).toHaveURL(/q=/);
  await page.reload();
  await expect(page.getByLabel("배송 검색")).toHaveValue("존재하지않는닉네임");
  await page.getByLabel("배송 검색").fill("");
  await expect(page).not.toHaveURL(/q=/);

  // 상세로 갔다 Back: 짧은 창에서 스크롤한 위치가 돌아온다
  await page.setViewportSize({ width: 1440, height: 320 });
  await page.goto("/seller/shipping?tab=ready");
  const link = page.getByTestId("shipment-row").first().getByRole("link").first();
  await expect(link).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(520);
  await page.evaluate(() => window.scrollTo(0, 200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await link.click();
  await expect(page).toHaveURL(/\/seller\/orders\/[0-9a-f-]+/);
  await page.goBack();
  await expect(page).toHaveURL(/\/seller\/shipping\?tab=ready$/);
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 8000 }).toBeGreaterThan(100);
});

test("환불 요청: ?status=로 열면 그 탭이 켜지고, 탭을 바꾸면 주소가 따라가며, 틀린 값은 처리 대기로 본다", async ({ page }) => {
  await login(page);
  await page.goto("/seller/orders/refund-requests?status=APPROVED");
  await expect(page.getByRole("tab", { name: /^승인/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /^처리 대기/ }).click();
  await expect(page).toHaveURL(/\/seller\/orders\/refund-requests$/);
  await page.getByRole("tab", { name: /^거절/ }).click();
  await expect(page).toHaveURL(/status=REJECTED$/);
  await page.reload();
  await expect(page.getByRole("tab", { name: /^거절/ })).toHaveAttribute("aria-selected", "true");
  await page.goto("/seller/orders/refund-requests?status=NOPE");
  await expect(page.getByRole("tab", { name: /^처리 대기/ })).toHaveAttribute("aria-selected", "true");
});

test("리뷰: ?tab=·?rating=으로 열면 그 조건이 켜지고, 바꾸면 주소가 따라간다", async ({ page }) => {
  await login(page);
  await page.goto("/seller/reviews?tab=waiting&rating=5");
  await expect(page.getByRole("tab", { name: "답글 대기" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("별점")).toHaveValue("5");
  await page.getByLabel("별점").selectOption("low");
  await expect(page).toHaveURL(/rating=low/);
  await page.getByRole("tab", { name: "전체" }).click();
  await expect(page).toHaveURL(/rating=low$/);
  // 주소가 바뀐 뒤 화면(탭 선택)이 다시 그려지길 기다린 다음에 별점을 바꾼다(그 전에 바꾸면 이전 주소 기준으로 계산된다)
  await expect(page.getByRole("tab", { name: "전체" })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("별점").selectOption("");
  await expect(page).toHaveURL(/\/seller\/reviews$/);
  await page.goto("/seller/reviews?tab=NOPE&rating=9");
  await expect(page.getByRole("tab", { name: "전체" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("별점")).toHaveValue("");
});
