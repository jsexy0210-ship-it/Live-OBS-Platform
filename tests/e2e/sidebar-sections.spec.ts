import { expect, test, type Page } from "@playwright/test";

test.use({ channel: "chrome" });

// Actual application rendering with isolated API fixtures. This does not claim DB/API E2E coverage.
async function fixture(page: Page, features = ["OVERLAY", "STORE_OPERATIONS"], owner = true) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    let status = 200;
    if (path === "/api/seller/me") body = { sellerId: "fixture", userId: "owner", isOwner: owner, permissions: [], access: "paid", features, shop: { name: "검수 쇼핑몰", slug: "fixture" }, user: { name: "검수", email: "fixture@example.com" }, trialEndsAt: null };
    else if (path === "/api/seller/bulk-io/jobs") body = { jobs: [] };
    else if (path === "/api/seller/member-messages") body = { messages: [], nextCursor: null, summary: { consented: 0, activeMembers: 0, consentedPercent: null, monthRecorded: 0, monthAlimtalk: 0, monthMail: 0, orders24h: 0, orders24hAmount: 0, withdrawn30: 0, withdrawn30Percent: null } };
    else if (path === "/api/seller/member-grades") body = { grades: [] };
    else if (path.startsWith("/api/seller/shop-legal/")) body = { doc: { kind: path.split("/").at(-1), body: "검수 문서", effectiveOn: null, isPublished: false, version: 1 } };
    else if (path === "/api/admin/me") body = { id: "master", name: "검수", email: "fixture@example.com", role: "READ_ONLY" };
    else if (path === "/api/admin/sellers/fixture") body = { seller: { id: "fixture", slug: "fixture", shopName: "검수 쇼핑몰", status: "ACTIVE", businessInfo: null, createdAt: "2026-10-06T00:00:00Z", trialEndsAt: null, approvedAt: null, owner: null, subscription: null, plan: null, orders30d: { created: 0, paid: 0, paidAmount: 0 }, assignedCs: null, inquiryOpenCount: 0, noteCount: 3 } };
    else if (path === "/api/admin/sellers") body = { sellers: [] };
    else if (path === "/api/admin/sellers/fixture/rewards") body = {
      policy: { saved: true, earnTiming: "ON_DELIVERY", revokeMode: "AUTO", expiryYears: 3, useMaxRatio: 30, grades: [{ id: "bronze", name: "브론즈", cardRate: 1, bankTransferRate: 2, members: 7 }] },
      limits: { rateMax: 10, withinLimits: true }, livePayout: { enabled: true, changedAt: "2026-10-06T00:00:00Z", changedByName: "검수" },
      totals: { balance: 12000, monthGranted: 3000, monthUsed: 1000, pending: { count: 2, amount: 300 }, failed: { count: 1, amount: 200 } }, history: [],
      anomalies: { balanceRatio: { status: "OK", ratio: 10 }, manualGrant: { status: "OK", count: 0, amount: 0 }, concentration: { status: "OK", ratio: 5 }, failRepeat: { status: "OK", count: 1 } },
    };
    else { status = 503; body = { error: "fixture_unavailable" }; }
    await route.fulfill({ status, json: body });
  });
}

async function menu(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 1024) await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  return page.locator(".lnb");
}

for (const width of [1440, 1024, 390]) {
  test(`통계 6종 사이드 메뉴와 기간 필터 보존 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto("/seller/stats/sales");
    const stats = (await menu(page)).getByRole("navigation", { name: "통계", exact: true });
    await expect(stats.getByRole("link")).toHaveText(["요약", "주문", "매출", "상품", "회원", "방송"]);
    await stats.getByRole("link", { name: "방송", exact: true }).click();
    await expect(page).toHaveURL(/\/seller\/stats\/broadcasts$/);
    await expect(page.getByRole("heading", { name: "통계 · 방송", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "통계 종류", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "7일", exact: true })).toBeVisible();
  });

  test(`회원 발송 URL·Back·재진입·모바일 메뉴 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto("/seller/member-messages?section=list&keep=1");
    const nav = await menu(page);
    await nav.getByRole("link", { name: "새 발송", exact: true }).click();
    await expect(page).toHaveURL(/section=new/);
    await expect(page.getByTestId("mm-new")).toBeVisible();
    await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("mm-new")).toBeVisible();
    await page.screenshot({ path: `tests/e2e/screenshots/sidebar-sections/member-new-${width}.png`, fullPage: false });
    await (await menu(page)).getByRole("link", { name: "발송 기록", exact: true }).click();
    await expect(page.getByTestId("mm-new")).toBeHidden();
    await page.goBack();
    await expect(page.getByTestId("mm-new")).toBeVisible();
  });

  test(`엑셀 section 이동·직접URL·active ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto("/seller/products/bulk?section=export");
    await expect(page.locator("#bulk-export")).toBeVisible();
    const nav = await menu(page);
    await expect(nav.getByRole("link", { name: "내보내기", exact: true })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "처리 이력", exact: true }).click();
    await expect(page).toHaveURL(/section=history/);
    await expect(page.getByTestId("bulk-tabs")).toHaveCount(0);
    await expect(page.locator("#bulk-history")).toBeVisible();
  });

  test(`약관 URL 패널·직접진입 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto("/seller/settings/legal?section=privacy");
    const nav = await menu(page);
    await expect(nav.getByRole("link", { name: "개인정보처리방침", exact: true })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "이용약관", exact: true }).click();
    await expect(page).toHaveURL(/section=terms/);
    await expect(page.getByRole("tablist")).toHaveCount(0);
  });

  test(`마스터 상세 9메뉴·메모 지표·적립금 읽기 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto("/admin/partners/fixture?tab=info");
    await expect(page.getByTestId("partner-badges")).toBeVisible();
    const nav = await menu(page);
    const detail = nav.getByRole("navigation", { name: "파트너스 정보", exact: true });
    await expect(detail.getByRole("link")).toHaveCount(9);
    await expect(detail.getByRole("link", { name: "메모 3", exact: true })).toBeVisible();
    await detail.getByRole("link", { name: "주문 현황", exact: true }).click();
    await expect(page).toHaveURL(/tab=orders/);
    await expect(page.getByRole("heading", { name: "파트너스 상세 · 주문 현황", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "파트너스 정보 탭" })).toHaveCount(0);
    const writes: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/rewards") && request.method() !== "GET") writes.push(request.method()); });
    await (await menu(page)).getByRole("link", { name: "적립금 설정", exact: true }).click();
    await expect(page).toHaveURL(/tab=rewards/);
    await expect(page.getByTestId("partner-rewards")).toBeVisible();
    await expect(page.getByRole("table", { name: "회원 등급별 적립률", exact: true })).toContainText("브론즈");
    await expect(page.getByTestId("partner-rewards")).toContainText("12,000원");
    await page.screenshot({ path: `tests/e2e/screenshots/sidebar-sections/partner-rewards-${width}.png`, fullPage: false });
    expect(writes).toEqual([]);
  });
}

test("요금제 제한은 사이드 메뉴 및 직접 URL에 유지", async ({ page }) => {
  await fixture(page, ["OVERLAY"]);
  await page.goto("/seller/products/bulk?section=history");
  await expect(page.locator(".lnb").getByRole("link", { name: "처리 이력", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("bulk-drop")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "엑셀 일괄 등록 · 내보내기", exact: true })).toHaveCount(0);
});

test("오버레이 플랜은 방송 통계 메뉴만 유지", async ({ page }) => {
  await fixture(page, ["OVERLAY"]);
  await page.goto("/seller/stats/broadcasts");
  await expect(page.locator(".lnb").getByRole("navigation", { name: "통계", exact: true }).getByRole("link")).toHaveText(["방송"]);
  await expect(page.getByRole("navigation", { name: "통계 종류", exact: true })).toHaveCount(0);
});

test("권한 없는 직원의 새 발송 직접 URL은 발송 기록만 표시", async ({ page }) => {
  await fixture(page, ["OVERLAY", "STORE_OPERATIONS"], false);
  await page.goto("/seller/member-messages?section=new");
  await expect(page.getByTestId("mm-summary")).toBeVisible();
  await expect(page.getByTestId("mm-new")).toHaveCount(0);
  await expect(page.locator(".lnb").getByRole("link", { name: "새 발송", exact: true })).toHaveCount(0);
});

test("알 수 없는 약관 section은 첫 문서로 돌아간다", async ({ page }) => {
  await fixture(page);
  await page.goto("/seller/settings/legal?section=invalid");
  await expect(page.locator(".lnb").getByRole("link", { name: "이용약관", exact: true })).toHaveAttribute("aria-current", "page");
});

test("새 발송 draft는 취소한 이동과 패널 전환에서 보존", async ({ page }) => {
  await fixture(page);
  await page.goto("/seller/member-messages?section=new");
  const title = page.getByTestId("mm-new").locator('input[maxlength="40"]');
  await title.fill("저장 전 초안");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator(".lnb").getByRole("link", { name: "발송 기록", exact: true }).click();
  await expect(page).toHaveURL(/section=new/);
  await expect(title).toHaveValue("저장 전 초안");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".lnb").getByRole("link", { name: "발송 기록", exact: true }).click();
  await expect(page.getByTestId("mm-new")).toBeHidden();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".lnb").getByRole("link", { name: "새 발송", exact: true }).click();
  await expect(title).toHaveValue("저장 전 초안");
});
