import { expect, test, type Page } from "@playwright/test";
import { clearCouponsInDb } from "./couponDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-035 쿠폰 관리(파트너스 관리자, 판매 › 쿠폰)와 SH-028 내 쿠폰함(구매자). 운영 빌드 + 데모 시드
// (demo-owner@example.com · demo-buyer1@example.com, 비밀번호는 E2E_PASSWORD). 시작·끝에 데모 쇼핑몰 쿠폰을 테스트 DB에서 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOT = "tests/e2e/screenshots";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearCouponsInDb(SLUG);
});
test.afterAll(() => clearCouponsInDb(SLUG));

async function ownerOpen(page: Page, path: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(path)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

async function buyerLogin(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}

async function shots(page: Page, name: string) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOT}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe.serial("SA-035 쿠폰 관리 · SH-028 내 쿠폰함", () => {
  test("대표자: 빈 목록 → 내려받기 쿠폰·코드 쿠폰 만들기(미리보기) → 목록·집계", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/coupons");
    await expect(page.getByRole("link", { name: "쿠폰", exact: true })).toHaveClass(/on/);
    await expect(page.getByText("만든 쿠폰이 없습니다")).toBeVisible();
    await shots(page, "sa035-empty");

    await page.getByRole("button", { name: "쿠폰 만들기" }).first().click();
    const dlg = page.getByRole("dialog", { name: "쿠폰 만들기" });
    await expect(dlg.getByRole("button", { name: "저장" })).toBeDisabled();
    await dlg.getByLabel("쿠폰 이름").fill("10월 스타라이트 오픈 기념");
    await dlg.getByLabel("할인 금액 (원)").fill("5000");
    await dlg.getByLabel("최소 주문 금액 (원)").fill("50000");
    await expect(dlg.getByTestId("coupon-preview")).toContainText("5,000원");
    await expect(dlg.getByTestId("coupon-preview")).toContainText("50,000원 이상 · 할인 중 상품 제외");
    await page.screenshot({ path: `${SHOT}/sa035-editor-1440.png` });
    await dlg.getByRole("button", { name: "저장" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByTestId("coupon-row")).toHaveCount(1);

    await page.getByRole("button", { name: "쿠폰 만들기" }).first().click();
    const dlg2 = page.getByRole("dialog", { name: "쿠폰 만들기" });
    await dlg2.getByLabel("쿠폰 이름").fill("방송 채팅 코드");
    await dlg2.getByRole("radio", { name: "코드 입력" }).click();
    await dlg2.getByLabel("쿠폰 코드").fill("starnight");
    await dlg2.getByRole("radio", { name: "배송비 무료" }).click();
    await dlg2.getByLabel("발급 수량 한도").fill("300");
    await dlg2.getByRole("button", { name: "저장" }).click();
    await expect(dlg2).toBeHidden();
    const rows = page.getByTestId("coupon-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "방송 채팅 코드" })).toContainText("코드 입력 · STARNIGHT");
    await expect(rows.filter({ hasText: "방송 채팅 코드" })).toContainText("0 / 300");
    await expect(page.getByText("발급 중").first()).toBeVisible();

    // 같은 코드는 다시 쓸 수 없다(대소문자 무시)
    await page.getByRole("button", { name: "쿠폰 만들기" }).first().click();
    const dup = page.getByRole("dialog", { name: "쿠폰 만들기" });
    await dup.getByLabel("쿠폰 이름").fill("중복 코드");
    await dup.getByRole("radio", { name: "코드 입력" }).click();
    await dup.getByLabel("쿠폰 코드").fill("StarNight");
    await dup.getByLabel("할인 금액 (원)").fill("1000");
    await dup.getByRole("button", { name: "저장" }).click();
    await expect(dup.getByRole("alert")).toContainText("이미 쓰는 코드입니다");
    await dup.getByRole("button", { name: "취소" }).click();
    await shots(page, "sa035-list");
  });

  test("구매자: 쿠폰 받기 · 코드 등록(대소문자 무시) · 틀린 코드 안내", async ({ page, baseURL }) => {
    await buyerLogin(page, baseURL!);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/shop/${SLUG}/coupons`);
    await expect(page.getByRole("heading", { name: "내 쿠폰함" })).toBeVisible();
    await expect(page.getByText("쓸 수 있는 쿠폰이 없어요")).toBeVisible();
    await page.getByRole("tab", { name: /받을 수 있어요/ }).click();
    await expect(page.getByText("10월 스타라이트 오픈 기념")).toBeVisible();
    await shots(page, "sh028-claimable");
    await page.getByRole("button", { name: "받기" }).click();
    await expect(page.locator("p.msg")).toContainText("쿠폰을 받았어요");
    await expect(page.getByRole("tab", { name: /쓸 수 있어요/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("50,000원 이상 주문 · 할인 중 상품 제외")).toBeVisible();

    await page.getByLabel("쿠폰 코드").fill("WRONGCODE");
    await page.getByRole("button", { name: "등록" }).click();
    await expect(page.locator("p.msg")).toContainText("맞는 코드가 아니에요");
    await page.getByLabel("쿠폰 코드").fill("starnight");
    await page.getByRole("button", { name: "등록" }).click();
    await expect(page.locator("p.msg")).toContainText("쿠폰을 받았어요");
    await expect(page.locator(".cb-item")).toHaveCount(2);
    await expect(page.getByText("배송비 무료").first()).toBeVisible();
    await shots(page, "sh028-usable");
  });

  test("대표자: 발급 수가 집계에 보이고, 발급 중지하면 구매자는 더 받을 수 없다", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ownerOpen(page, "/seller/coupons");
    const row = page.getByTestId("coupon-row").filter({ hasText: "10월 스타라이트 오픈 기념" });
    await expect(row.locator("td").nth(3)).toHaveText("1");
    // 발급한 쿠폰은 삭제 버튼이 없다
    await expect(row.getByRole("button", { name: "삭제" })).toHaveCount(0);
    await row.getByRole("button", { name: "발급 중지" }).click();
    const confirm = page.getByRole("dialog", { name: "발급을 중지하시겠습니까?" });
    await expect(confirm).toContainText("이미 받은 1장은 기간 안에 그대로 쓸 수 있습니다");
    await confirm.getByRole("button", { name: "발급 중지" }).click();
    await expect(row.getByText("종료")).toBeVisible();
    await expect(row.getByRole("button", { name: "다시 발급" })).toBeVisible();

    await buyerLogin(page, baseURL!);
    const box = (await (await page.request.get(`/api/shop/${SLUG}/coupons`)).json()) as { usable: { name: string }[]; claimable: unknown[] };
    expect(box.claimable).toEqual([]);
    // 이미 받은 쿠폰은 그대로 쓸 수 있다
    expect(box.usable.map((c) => c.name).sort()).toEqual(["10월 스타라이트 오픈 기념", "방송 채팅 코드"]);
  });
});
