import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-082 배송 자동화: 서버 값(잔액·단가·사용)을 그대로 보이고, 기능을 켜고 끌 때 확인 창을 거쳐 저장된다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function openAs(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fshipping-automation");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/shipping-automation$/);
}

test("대표자: 기능 4개와 잔액·사용을 보고, 켜기·끄기는 확인 창을 거친다(끝에 원래대로 돌린다)", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await expect(page.getByRole("heading", { name: "배송 자동화" })).toBeVisible();
  await expect(page.getByText("발송 · 이용 충전금 잔액")).toBeVisible();
  await expect(page.getByText("이번 달 사용 건수").first()).toBeVisible();
  const rows = page.locator("table.tbl tbody tr");
  await expect(rows).toHaveCount(4);
  for (const name of ["송장 자동 발급", "송장 출력", "배송 자동 조회", "반품 송장 연동"]) await expect(page.getByRole("cell", { name }).first()).toBeVisible();

  if (process.env.E2E_SCREENSHOTS === "1") {
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `tests/e2e/screenshots/SA-082-automation-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  const group = page.getByRole("group", { name: "송장 출력 사용" });
  const wasOn = (await group.getByRole("button", { name: "켜짐" }).getAttribute("aria-pressed")) === "true";
  const flip = async (toOn: boolean) => {
    await group.getByRole("button", { name: toOn ? "켜짐" : "꺼짐" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(toOn ? "켜시겠습니까?" : "끄시겠습니까?");
    await Promise.all([page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/shipping-automation") && r.ok()), dialog.getByRole("button", { name: toOn ? "켜기" : "끄기", exact: true }).click()]);
    await expect(group.getByRole("button", { name: toOn ? "켜짐" : "꺼짐" })).toHaveAttribute("aria-pressed", "true");
  };
  await flip(!wasOn);
  await page.reload();
  await expect(page.getByRole("group", { name: "송장 출력 사용" }).getByRole("button", { name: wasOn ? "꺼짐" : "켜짐" })).toHaveAttribute("aria-pressed", "true");
  await flip(wasOn);
});

test("취소하면 값이 바뀌지 않는다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  const group = page.getByRole("group", { name: "반품 송장 연동 사용" });
  const before = await group.getByRole("button", { name: "켜짐" }).getAttribute("aria-pressed");
  await group.getByRole("button", { name: before === "true" ? "꺼짐" : "켜짐" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();
  await expect(group.getByRole("button", { name: "켜짐" })).toHaveAttribute("aria-pressed", before!);
});
