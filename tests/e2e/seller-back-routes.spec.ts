import { expect, test, type Page } from "@playwright/test";
import { clearCouponsInDb, createClaimableCouponInDb } from "./couponDb";
import { submitSellerLogin } from "./sellerLogin";

// 화면-Back 경로표(docs/BACK_ROUTES.md) 파트너스 묶음: 직접 URL 진입 / 목록 → 상세 → ← / 브라우저 Back 각각의 결과(IA Back 규칙 1·3항).
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

const login = async (page: Page, next: string) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
};

test("회원 상세: 직접 진입 → 「회원 목록」은 부모로 replace(기록이 쌓이지 않음), 목록 → 상세 → ←는 목록 조건으로 돌아온다", async ({ page }) => {
  await login(page, "/seller/members");
  await expect(page.getByTestId("member-row").first()).toBeVisible();
  await page.getByRole("button", { name: /^활동/ }).click();
  await expect(page).toHaveURL(/\/seller\/members\?status=ACTIVE$/);
  const detail = await page.getByTestId("member-row").first().getByRole("link").getAttribute("href");

  // 목록 → 상세 → ←
  await page.getByTestId("member-row").first().getByRole("link").click();
  await expect(page).toHaveURL(/\/seller\/members\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "뒤로" }).click();
  await expect(page).toHaveURL(/\/seller\/members\?status=ACTIVE$/);
  await expect(page.getByRole("button", { name: /^활동/ })).toHaveAttribute("aria-pressed", "true");

  // 직접 URL → ←: 부모로 replace, 이어서 브라우저 Back은 직접 진입 전 화면으로
  await page.goto("about:blank");
  await page.goto(detail!);
  await expect(page.getByRole("button", { name: "뒤로" })).toBeVisible();
  await page.getByRole("button", { name: "뒤로" }).click();
  await expect(page).toHaveURL(/\/seller\/members$/);
  await page.goBack();
  await expect(page).toHaveURL("about:blank");
});

test("통계 하위 화면: 기간은 주소에 남고 ←는 통계 요약으로, 직접 진입도 같다", async ({ page }) => {
  await login(page, "/seller/stats/orders");
  await expect(page).toHaveURL(/\/seller\/stats\/orders$/);
  await page.getByRole("button", { name: "7일", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/stats\/orders\?preset=7d$/);
  await page.reload();
  await expect(page.getByRole("button", { name: "7일", exact: true })).toHaveAttribute("aria-pressed", "true");
  // 직접 진입(이 영역의 이전 화면이 없음) → 부모로 replace
  await page.getByRole("button", { name: "뒤로" }).click();
  await expect(page).toHaveURL(/\/seller\/stats$/);
});

test("문의하기: 입력 중 ←는 확인을 묻고, 취소하면 머물고 확인하면 내 문의로 간다", async ({ page }) => {
  await login(page, "/seller/inquiries");
  await expect(page).toHaveURL(/\/seller\/inquiries$/);
  await page.getByRole("link", { name: "문의하기" }).first().click();
  await expect(page).toHaveURL(/\/seller\/inquiries\/new$/);
  await expect(page.getByRole("button", { name: "뒤로" })).toBeVisible();
  const seen: string[] = [];
  let answer = false;
  page.on("dialog", (d) => {
    seen.push(d.message());
    void (answer ? d.accept() : d.dismiss());
  });
  await page.getByLabel(/제목/).fill("Back 확인");
  await page.getByRole("button", { name: "뒤로" }).click();
  await expect.poll(() => seen.length).toBe(1);
  await expect(page).toHaveURL(/\/seller\/inquiries\/new$/);
  answer = true;
  await page.getByRole("button", { name: "뒤로" }).click();
  await expect(page).toHaveURL(/\/seller\/inquiries$/);
});

test("상품 수정: 목록 → 수정 → 취소는 목록 조건으로 돌아온다", async ({ page }) => {
  await login(page, "/seller/products"); // 로그인 next는 쿼리를 버린다(UX-14, 인증 묶음에서 고침)
  await expect(page).toHaveURL(/\/seller\/products$/);
  const id = await page.evaluate(async () => (await (await fetch("/api/seller/products")).json()).products[0].id as string);
  await page.goto(`/seller/products?sort=price_asc`);
  await expect(page).toHaveURL(/\/seller\/products\?sort=price_asc$/);
  await page.locator(`a[href="/seller/products/${id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/seller/products/${id}$`));
  await page.getByRole("button", { name: "취소" }).first().click();
  await expect(page).toHaveURL(/\/seller\/products\?sort=price_asc$/);
});

test("목록 조건은 주소에 남아 새로고침·다른 화면 → Back에서도 유지된다(적립금 원장 상태·방송 이력 기간)", async ({ page }) => {
  await login(page, "/seller/rewards/ledger");
  await page.getByLabel("상태", { exact: true }).selectOption("SUCCEEDED");
  await page.getByRole("button", { name: "검색" }).click();
  // 기본 기간은 주소에서 생략하고, 선택한 상태 조건은 주소에 남는다.
  await expect.poll(() => {
    const url = new URL(page.url());
    return url.pathname === "/seller/rewards/ledger" && url.searchParams.get("status") === "SUCCEEDED";
  }).toBe(true);
  const ledgerUrl = new URL(page.url());
  expect(ledgerUrl.pathname).toBe("/seller/rewards/ledger");
  expect(ledgerUrl.searchParams.get("status")).toBe("SUCCEEDED");
  expect(ledgerUrl.searchParams.has("from")).toBe(false);
  expect(ledgerUrl.searchParams.has("to")).toBe(false);
  await page.reload();
  await expect(page.getByLabel("상태", { exact: true })).toHaveValue("SUCCEEDED");

  await page.goto("/seller/broadcasts");
  await page.getByLabel("시작일").fill("2026-09-01");
  await page.getByLabel("종료일").fill("2026-10-01");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page).toHaveURL(/\/seller\/broadcasts\?from=2026-09-01&to=2026-10-01$/);
  await page.reload();
  await expect(page.getByLabel("시작일")).toHaveValue("2026.09.01");
});

test("설정 폼: 바꾼 것이 있으면 메뉴 이동·브라우저 Back에서 묻고, 저장 안 한 채 나가기를 취소하면 머문다", async ({ page }) => {
  await login(page, "/seller/settings/shop");
  const title = page.getByLabel("공유 제목");
  await expect(title).toBeVisible();
  const seen: string[] = [];
  let answer = false;
  page.on("dialog", (d) => {
    seen.push(d.message());
    void (answer ? d.accept() : d.dismiss());
  });
  await title.fill(`${await title.inputValue()}수정`);
  await page.getByRole("link", { name: "주문 · 배송 설정" }).first().click();
  await expect.poll(() => seen.length).toBe(1);
  await expect(page).toHaveURL(/\/seller\/settings\/shop$/);
  answer = true;
  await page.getByRole("link", { name: "주문 · 배송 설정" }).first().click();
  await expect(page).toHaveURL(/\/seller\/settings\/order$/);
});

test("쿠폰 상태 탭은 주소(?tab=)에 남아 새로고침해도 유지된다", async ({ page }) => {
  await createClaimableCouponInDb("demo-shop", "Back 시험 쿠폰", 1000);
  try {
    await login(page, "/seller/coupons");
    await page.getByRole("tab", { name: /^발급 중/ }).click();
    await expect(page).toHaveURL(/\/seller\/coupons\?tab=live$/);
    await page.reload();
    await expect(page.getByRole("tab", { name: /^발급 중/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /^전체/ }).click();
    await expect(page).toHaveURL(/\/seller\/coupons$/);
  } finally {
    await clearCouponsInDb("demo-shop");
  }
});
