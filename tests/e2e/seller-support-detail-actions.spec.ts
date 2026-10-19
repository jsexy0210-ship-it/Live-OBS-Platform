import { expect, test, type Page, type Route } from "@playwright/test";

// All API requests are mocked. These cases never apply a DB/business mutation.
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const at = "2026-10-19T10:00:00.000Z";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
async function mockSeller(page: Page, handler: (route: Route, path: string) => Promise<boolean>) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/seller/me") { await json(route, { sellerId: id(900), userId: id(901), isOwner: true, permissions: [], access: "paid", features: ["STORE_OPERATIONS", "OVERLAY", "EXTERNAL_INTEGRATION"], shop: { name: "검증 쇼핑몰", slug: "review-shop" }, user: { name: "검증 대표자", email: "review@example.com" }, trialEndsAt: null }); return; }
    if (await handler(route, path)) return;
    expect(route.request().method(), `unexpected API ${path}`).toBe("GET");
    await json(route, { items: [], notifications: [], unread: 0, unreadCount: 0, count: 0, enabled: false, maintenance: null });
  });
}
const coupon = (n: number) => ({ id: id(n), name: `쿠폰 ${n}`, issueMethod: "MANUAL", code: null, benefit: "AMOUNT", value: 1000, maxDiscount: null, minOrderAmount: 0, startsAt: "2026-10-01T00:00:00+09:00", endsAt: "2027-12-31T23:59:59+09:00", validDays: null, issueLimit: null, issuedCount: 1, productIds: [], excludeDiscounted: true, allowWithReward: true, isActive: true, benefitText: "1,000원 할인", status: "live", soldOut: false, used: 0, discountTotal: 0 });
const coupons = (items: ReturnType<typeof coupon>[]) => ({ coupons: items, grades: [{ id: id(800), name: "VIP", members: 2 }], products: [], canEdit: true, summary: { live: items.length, monthUsed: 0, monthDiscount: 0, monthCouponOrderRate: 0, expiringSoon: 0 } });
const review = (n: number) => ({ id: id(n), productName: `상품 ${n}`, optionName: "기본", quantity: 1, author: "검증 구매자", rating: 5, body: "리뷰 내용", status: "PENDING", heldLabel: null, hiddenReason: null, hiddenNote: null, reply: null, repliedAt: null, reportCount: 0, reportReasons: {}, rewardedAmount: 0, revokePending: 0, images: [], orderedAt: at, deliveredAt: at, createdAt: at });
const reviewList = { reviews: [], nextCursor: null, canEdit: true, policy: { publishMode: "REVIEW", rewardText: 100, rewardPhoto: 200, writableDays: 30, bannedWords: [] }, summary: { average: null, total: 0, weekNew: 0, weekPhoto: 0, waitingReply: 0, waitingOld: 0, pendingOrHeld: 0, autoHeld: 0, distribution: [] } };

test("문의 단건 직접 진입과 dirty 취소 보존·답변 PUT을 실제 상세에서 처리한다", async ({ page }) => {
  const writes: unknown[] = [], reads: string[] = [];
  await mockSeller(page, async (route, path) => {
    if (path === `/api/seller/inquiries/${id(25)}`) { reads.push(path); await json(route, { canEdit: true, inquiry: { id: id(25), kind: "GENERAL", product: null, order: null, title: "목록 밖 문의", body: "원 문의 내용", isPrivate: true, status: "WAITING", answer: null, answeredAt: null, createdAt: at, authorNickname: "검증 구매자", images: [] } }); return true; }
    if (path === `/api/seller/inquiries/${id(25)}/answer`) { writes.push(route.request().postDataJSON()); await json(route, { ok: true }); return true; }
    return false;
  });
  await page.goto(`/seller/buyer-inquiries/${id(25)}?returnTo=${encodeURIComponent("/seller/buyer-inquiries?status=WAITING")}`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("원 문의 내용", { exact: true })).toBeVisible();
  await page.getByLabel("답변", { exact: true }).fill("보관할 답변");
  page.once("dialog", d => void d.dismiss());
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("답변", { exact: true })).toHaveValue("보관할 답변");
  expect(writes).toEqual([]); expect(reads).toEqual([`/api/seller/inquiries/${id(25)}`]);
  await page.getByRole("button", { name: "답변 저장", exact: true }).click();
  await expect(page.getByText("답변을 저장했습니다", { exact: true })).toBeVisible();
  expect(writes).toEqual([{ answer: "보관할 답변" }]);
  expect(await page.evaluate(() => !!history.state?.unsavedGuard)).toBe(false);
});

test("선택 리뷰의 404만 제외하고 다른 단건 오류는 전체 작업을 막는다", async ({ page }) => {
  let denied = false;
  const reads: string[] = [], writes: unknown[] = [];
  await mockSeller(page, async (route, path) => {
    if (path === "/api/seller/reviews") { await json(route, reviewList); return true; }
    if (path === `/api/seller/reviews/${id(1)}`) { reads.push(path); await json(route, { review: review(1) }); return true; }
    if (path === `/api/seller/reviews/${id(2)}`) { reads.push(path); await json(route, { error: denied ? "forbidden" : "not_found" }, denied ? 403 : 404); return true; }
    if (route.request().method() !== "GET") { writes.push(path); await json(route, { ok: true }); return true; }
    return false;
  });
  const url = `/seller/reviews/operations?ids=${id(1)},${id(2)}&action=publish`;
  await page.goto(url);
  await expect(page.getByText("찾을 수 없는 리뷰 1건을 선택에서 제외했습니다", { exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("button", { name: "공개", exact: true })).toBeEnabled();
  expect(reads).toEqual([`/api/seller/reviews/${id(1)}`, `/api/seller/reviews/${id(2)}`]);
  denied = true; await page.reload();
  await expect(page.locator("main").getByRole("button", { name: "공개", exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("큰 쿠폰 전체 선택은 URL을 늘리거나 ID를 자르지 않고 같은 탭에서 재진입한다", async ({ page }) => {
  const all = Array.from({ length: 600 }, (_, i) => coupon(i + 1));
  const writes: unknown[] = [];
  await mockSeller(page, async (route, path) => {
    if (path === "/api/seller/coupons") { await json(route, coupons(all)); return true; }
    if (route.request().method() !== "GET") { writes.push(path); await json(route, { ok: true }); return true; }
    return false;
  });
  await page.goto("/seller/coupons");
  await page.getByRole("checkbox", { name: "쿠폰 모두 선택", exact: true }).check();
  await page.getByRole("button", { name: "선택 발급 중지", exact: true }).click();
  await expect(page).toHaveURL(/coupons\/operations\?selectionKey=/);
  const key = new URL(page.url()).searchParams.get("selectionKey")!;
  expect(new URL(page.url()).searchParams.has("ids")).toBe(false);
  await expect(page.locator('main input[type="checkbox"]')).toHaveCount(600);
  await page.reload();
  await expect(page.locator('main input[type="checkbox"]:checked')).toHaveCount(600);
  const stored = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), key);
  expect(Object.keys(stored).sort()).toEqual(["ids", "scope", "sellerId"]);
  expect(stored.ids).toEqual(all.map(c => c.id));
  await page.evaluate(key => { const value = JSON.parse(sessionStorage.getItem(key)!); value.sellerId = "another-shop"; sessionStorage.setItem(key, JSON.stringify(value)); }, key);
  await page.reload();
  await expect(page.locator("main").getByRole("button", { name: "선택 발급 중지", exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("발급한 쿠폰의 혜택 잠금과 등급 지급의 같은 본문·부분 결과를 보존한다", async ({ page }) => {
  const writes: unknown[] = [];
  await mockSeller(page, async (route, path) => {
    if (path === "/api/seller/coupons") { await json(route, coupons([coupon(1)])); return true; }
    if (path === `/api/seller/coupons/${id(1)}/grant`) { writes.push(route.request().postDataJSON()); await json(route, { granted: 1, skipped: 1 }); return true; }
    return false;
  });
  await page.goto(`/seller/coupons/${id(1)}`);
  await expect(page.getByRole("radio", { name: "비율 할인", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "쿠폰 삭제", exact: true })).toHaveCount(0);
  await page.goto(`/seller/coupons/${id(1)}/grant`);
  await page.getByRole("checkbox", { name: /VIP/ }).check();
  page.once("dialog", d => void d.dismiss());
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /VIP/ })).toBeChecked();
  await page.getByRole("button", { name: "2명에게 지급", exact: true }).click();
  await expect(page).toHaveURL(/seller\/coupons$/);
  await expect(page.getByText("1명에게 지급했습니다 · 이미 받은 1명 제외", { exact: true })).toBeVisible();
  expect(writes).toEqual([{ gradeIds: [id(800)] }]);
});

test("배너 목록의 순서 버튼은 실제 노출 상세로 옮기고 전체 ID·409 복구를 유지한다", async ({ page }) => {
  let all = [1, 2, 3].map(n => ({ id: id(n), title: `배너 ${n}`, pcImage: { id: id(100 + n), url: `/mock-${n}.png`, width: 1920, height: 600 }, mobileImage: null, linkUrl: null, startsAt: null, endsAt: null, showOnPc: true, showOnMobile: true, isActive: true, status: "live" }));
  const writes: string[][] = [];
  await mockSeller(page, async (route, path) => {
    if (path === "/api/seller/shop-content/banners") { await json(route, { banners: all, intervalSec: 0 }); return true; }
    if (path.endsWith("/banners/reorder")) { const ids: string[] = route.request().postDataJSON().ids; writes.push(ids); if (writes.length === 1) { await json(route, { error: "order_conflict", message: "목록이 바뀌었습니다" }, 409); } else { all = ids.map(id => all.find(b => b.id === id)!); await json(route, { ok: true }); } return true; }
    return false;
  });
  await page.goto("/seller/banners");
  await expect(page.getByRole("button", { name: "배너 3 위로", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "노출 설정 상세", exact: true }).click();
  await page.getByRole("button", { name: "배너 3 위로", exact: true }).click();
  await expect(page.getByText("목록이 바뀌었습니다", { exact: true })).toBeVisible();
  await expect(page.getByTestId("banner-order-row").first()).toContainText("배너 1");
  await page.getByRole("button", { name: "배너 3 위로", exact: true }).click();
  await expect(page.getByTestId("banner-order-row").nth(1)).toContainText("배너 3");
  expect(writes).toEqual([[id(1), id(3), id(2)], [id(1), id(3), id(2)]]);
});

for (const menu of ["buyer-inquiries", "reviews"] as const) test(`${menu}의 현재 커서 쪽은 실제 상세와 목록을 왕복해도 유지한다`, async ({ page }) => {
  const reads: string[] = [];
  const inquiry = (n: number) => ({ id: id(n), kind: "GENERAL", product: null, order: null, title: `문의 ${n}`, body: "원 문의", isPrivate: false, status: "WAITING", answer: null, answeredAt: null, createdAt: at, authorNickname: "검증 구매자", images: [] });
  await mockSeller(page, async (route, path) => {
    if (path === "/api/seller/inquiries") { const cursor = new URL(route.request().url()).searchParams.get("cursor") ?? ""; reads.push(cursor); await json(route, { inquiries: [inquiry(cursor ? 25 : 1)], canEdit: true, waitingCount: 2, nextCursor: cursor ? null : "page-two" }); return true; }
    if (path === `/api/seller/inquiries/${id(25)}`) { await json(route, { inquiry: inquiry(25), canEdit: true }); return true; }
    if (path === "/api/seller/reviews") { const cursor = new URL(route.request().url()).searchParams.get("cursor") ?? ""; reads.push(cursor); const item = review(cursor ? 25 : 1); await json(route, { ...reviewList, reviews: [{ ...item, grade: null, photos: 0, replied: false }], nextCursor: cursor ? null : "page-two" }); return true; }
    if (path === `/api/seller/reviews/${id(25)}`) { await json(route, { review: review(25) }); return true; }
    return false;
  });
  await page.goto(`/seller/${menu}`);
  const rows = page.getByTestId(menu === "reviews" ? "review-row" : "inquiry-row");
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(rows).toContainText(menu === "reviews" ? "상품 25" : "문의 25");
  await rows.getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`${menu}/${id(25)}`));
  await page.locator("main").getByRole("link", { name: "목록", exact: true }).click();
  await expect(rows).toContainText(menu === "reviews" ? "상품 25" : "문의 25");
  expect(reads.at(-1)).toBe("page-two");
});
