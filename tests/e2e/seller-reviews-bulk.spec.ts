import { expect, test, type Page } from "@playwright/test";
import { clearReviewsInDb, deliveredItemInDb, reviewInDb } from "./reviewDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-048 리뷰: 체크 열 + 「선택 숨김 · 선택 공개」. 건별 hide·publish API를 차례로 불러 처리하고 결과를 알린다. 운영 빌드 + 데모 시드(demo-owner, 비밀번호 E2E_PASSWORD).
// 시작·끝에 데모 쇼핑몰의 리뷰와 이 시험이 만든 주문(900000번대)을 폐기용 DB에서 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearReviewsInDb(SLUG);
  for (let i = 0; i < 3; i++) await reviewInDb(await deliveredItemInDb(SLUG, "demo-buyer1@example.com"));
});
test.afterAll(() => clearReviewsInDb(SLUG));

test("선택 숨김은 사유를 고른 뒤 선택한 리뷰만 숨기고, 선택 공개로 다시 공개한다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Freviews");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/reviews$/);
  const rows = page.getByTestId("review-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole("region", { name: "선택한 리뷰 처리" })).toHaveCount(0);

  // 2건을 골라 숨긴다 — 사유를 고르기 전에는 숨기기가 잠겨 있다
  await rows.nth(0).getByRole("checkbox").check();
  await rows.nth(1).getByRole("checkbox").check();
  const bar = page.getByRole("region", { name: "선택한 리뷰 처리" });
  await expect(bar).toContainText("선택 2건");
  await shot(page, "SA-048-bulk-bar");
  await bar.getByRole("button", { name: "선택 숨김" }).click();
  const dialog = page.locator("main section").filter({ has: page.getByRole("button", { name: "개인정보 · 연락처 포함", exact: true }) });
  await expect(dialog.getByRole("button", { name: "숨기기", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "욕설 · 비방" }).click();
  await shot(page, "SA-048-bulk-hide");
  await dialog.getByRole("button", { name: "숨기기", exact: true }).click();
  await expect(page.getByText("선택한 2건을 숨김 처리했습니다")).toBeVisible();
  await page.getByRole("link", { name: "목록", exact: true }).click();
  await expect(rows.filter({ hasText: "숨김" })).toHaveCount(2);
  await expect(page.getByRole("region", { name: "선택한 리뷰 처리" })).toHaveCount(0);

  // 이 쪽 모두 선택 → 선택 공개: 이미 공개인 1건도 함께 보내 3건 모두 공개 상태로 맞춘다
  await page.getByRole("checkbox", { name: "이 쪽 리뷰 모두 선택" }).check();
  await expect(page.getByRole("region", { name: "선택한 리뷰 처리" })).toContainText("선택 3건");
  await page.getByRole("button", { name: "선택 공개" }).click();
  await page.locator("main").getByRole("button", { name: "공개", exact: true }).click();
  const confirmBox = page.getByRole("dialog");
  await expect(confirmBox).toContainText("선택한 3건을 공개하시겠습니까?");
  await expect(confirmBox).toContainText("적립금이 지급될 수 있습니다");
  await shot(page, "SA-048-bulk-publish-confirm");
  await confirmBox.getByRole("button", { name: "공개", exact: true }).click();
  await expect(page.getByText("선택한 3건을 공개했습니다")).toBeVisible();
  await page.getByRole("link", { name: "목록", exact: true }).click();
  await expect(rows.filter({ hasText: "숨김" })).toHaveCount(0);
});

test("선택을 풀면 처리 막대가 사라진다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Freviews");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  const rows = page.getByTestId("review-row");
  await rows.nth(0).getByRole("checkbox").check();
  await expect(page.getByRole("region", { name: "선택한 리뷰 처리" })).toBeVisible();
  await page.getByRole("button", { name: "선택 해제" }).click();
  await expect(page.getByRole("region", { name: "선택한 리뷰 처리" })).toHaveCount(0);
});
