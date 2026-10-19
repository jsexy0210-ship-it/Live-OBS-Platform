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
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${menu}/${id(25)}`));
  await page.locator("main").getByRole("link", { name: "목록", exact: true }).click();
  await expect(rows).toContainText(menu === "reviews" ? "상품 25" : "문의 25");
  expect(reads.at(-1)).toBe("page-two");
  expect(await page.evaluate(menu => sessionStorage.getItem(`streamshop:${menu}:return`), menu)).toBeNull();
  await page.getByRole("button", { name: "이전", exact: true }).click();
  await expect(rows).toContainText(menu === "reviews" ? "상품 1" : "문의 1");
  expect(reads.at(-1)).toBe("");
  await page.goto(`/seller/${menu}`);
  await expect(rows).toContainText(menu === "reviews" ? "상품 1" : "문의 1");
  expect(reads.at(-1)).toBe("");
});

for (const remaining of [1, 0]) test(`선택 뒤 사라진 쿠폰은 명시 제외하고 남은 ${remaining}건만 처리한다`, async ({ page }) => {
  const writes: { path: string; body: unknown }[] = [];
  let stopped = false;
  await mockSeller(page, async (route, path) => {
    if (path === "/api/seller/coupons") { await json(route, coupons(remaining ? [{ ...coupon(2), isActive: !stopped }] : [])); return true; }
    if (route.request().method() !== "GET") { writes.push({ path, body: route.request().postDataJSON() }); stopped = true; await json(route, { ok: true }); return true; }
    return false;
  });
  await page.goto(`/seller/coupons/operations?ids=${id(1)},${id(2)}`);
  await expect(page.locator("main").getByRole("status")).toContainText(`찾을 수 없는 쿠폰 ${2 - remaining}개를 선택에서 제외했습니다`);
  await expect(page.locator('main input[type="checkbox"]:checked')).toHaveCount(remaining);
  const run = page.locator("main").getByRole("button", { name: "선택 발급 중지", exact: true });
  if (!remaining) {
    await expect(run).toBeDisabled();
    await expect(page.locator("main")).toContainText("처리할 수 있는 쿠폰이 없습니다");
  } else {
    await run.click();
    await page.getByRole("dialog").getByRole("button", { name: "발급 중지", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1개의 발급을 중지했습니다" })).toBeVisible();
  }
  expect(writes).toEqual(remaining ? [{ path: `/api/seller/coupons/${id(2)}`, body: { isActive: false } }] : []);
});

test("손상된 쿠폰 선택 키와 잘못된 ID는 임의 일부 선택으로 복구하지 않는다", async ({ page }) => {
  const writes: string[] = [];
  await mockSeller(page, async (route, path) => {
    if (path === "/api/seller/coupons") { await json(route, coupons([coupon(2)])); return true; }
    if (route.request().method() !== "GET") { writes.push(path); await json(route, { ok: true }); return true; }
    return false;
  });
  await page.goto("/seller/coupons/operations?selectionKey=streamshop:coupon-stop:broken");
  await page.evaluate(() => sessionStorage.setItem("streamshop:coupon-stop:broken", "{"));
  await page.reload();
  await expect(page.locator("main").getByRole("button", { name: "선택 발급 중지", exact: true })).toHaveCount(0);
  await page.goto(`/seller/coupons/operations?ids=malformed,${id(2)}`);
  await expect(page.locator("main").getByRole("button", { name: "선택 발급 중지", exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

const detailBackCases = [
  { name: "문의 답변", path: `/seller/buyer-inquiries/${id(1)}`, list: "/seller/buyer-inquiries?status=WAITING", selector: "#bi-answer" },
  { name: "리뷰 답글", path: `/seller/reviews/${id(1)}`, list: "/seller/reviews?rating=5", selector: "#rv-reply" },
  { name: "리뷰 정책", path: "/seller/reviews/settings", list: "/seller/reviews?rating=5", selector: "#rv-words" },
  { name: "선택 리뷰 사유", path: `/seller/reviews/operations?ids=${id(1)}&action=hide`, list: "/seller/reviews?rating=5", label: "사유 설명" },
  { name: "쿠폰 수정", path: `/seller/coupons/${id(1)}`, list: "/seller/coupons?q=kept", selector: "#cp-name" },
  { name: "쿠폰 지급", path: `/seller/coupons/${id(1)}/grant`, list: "/seller/coupons?q=kept", checkbox: "VIP" },
  { name: "배너 등록", path: "/seller/banners/new", list: "/seller/banners?q=kept", selector: "#banner-title" },
  { name: "팝업 등록", path: "/seller/banners/popups/new", list: "/seller/banners/popups?q=kept", selector: "#popup-title" },
  { name: "상점 공지", path: "/seller/settings/shop-notices/new?kind=notice", list: "/seller/settings/shop-notices?category=kept", selector: "#notice-title" },
  { name: "직원 등록", path: "/seller/staff/new", list: "/seller/staff?q=kept", selector: "#sa-name" },
  { name: "직원 수정", path: `/seller/staff/${id(1)}`, list: "/seller/staff?q=kept", selector: "#se-name" },
  { name: "직원 비밀번호", path: `/seller/staff/${id(1)}?operation=password`, list: "/seller/staff?q=kept", selector: "#sp-new" },
];
const mockStaff = { id: id(1), email: "staff@example.com", name: "검증 직원", phone: null, identityLinked: false, permissions: [], status: "ACTIVE", lastLoginAt: null, createdAt: at };
async function backReads(route: Route, path: string) {
  if (path === `/api/seller/inquiries/${id(1)}`) { await json(route, { canEdit: true, inquiry: { id: id(1), kind: "GENERAL", product: null, order: null, title: "검증 문의", body: "원 문의", isPrivate: false, status: "WAITING", answer: null, answeredAt: null, createdAt: at, authorNickname: "검증 구매자", images: [] } }); return true; }
  if (path === "/api/seller/inquiries") { await json(route, { inquiries: [], canEdit: true, waitingCount: 0, nextCursor: null }); return true; }
  if (path === `/api/seller/reviews/${id(1)}`) { await json(route, { review: review(1) }); return true; }
  if (path === "/api/seller/reviews") { await json(route, reviewList); return true; }
  if (path === "/api/seller/coupons") { await json(route, coupons([coupon(1)])); return true; }
  if (path === "/api/seller/shop-content/banners") { await json(route, { banners: [], intervalSec: 0 }); return true; }
  if (path === "/api/seller/shop-content/popups") { await json(route, { popups: [], popupsPaused: false, pausedAt: null, pausedByName: null }); return true; }
  if (path === "/api/seller/notices") { await json(route, { items: [] }); return true; }
  if (path === "/api/seller/staff") { await json(route, { staff: [mockStaff] }); return true; }
  return false;
}
for (const entry of ["직접 진입", "새로고침"]) for (const scenario of detailBackCases) test(`${scenario.name} ${entry} ← 확인 취소는 입력을 보존하고 확인은 보호 기록을 소비한다`, async ({ page }) => {
  const writes: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockSeller(page, async (route, path) => {
    if (route.request().method() !== "GET") { writes.push(path); await json(route, { error: "unexpected_write" }, 409); return true; }
    return backReads(route, path);
  });
  const url = new URL(scenario.path, "http://localhost"); url.searchParams.set("returnTo", scenario.list);
  await page.goto(url.pathname + url.search);
  if (entry === "새로고침") await page.reload();
  const field = scenario.checkbox ? page.getByRole("checkbox", { name: new RegExp(scenario.checkbox) }) : scenario.selector ? page.locator(scenario.selector) : page.getByLabel(scenario.label!, { exact: true });
  if (scenario.checkbox) await field.check(); else await field.fill("보관할 입력");
  await expect.poll(() => page.evaluate(() => !!history.state?.unsavedGuard)).toBe(true);
  const detail = page.url(), messages: string[] = [];
  page.once("dialog", dialog => { messages.push(dialog.message()); void dialog.dismiss(); });
  await page.locator("main").getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(detail);
  if (scenario.checkbox) await expect(field).toBeChecked(); else await expect(field).toHaveValue("보관할 입력");
  page.once("dialog", dialog => { messages.push(dialog.message()); void dialog.accept(); });
  await page.locator("main").getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(current => current.pathname + current.search === scenario.list);
  expect(messages).toEqual(Array(2).fill("저장하지 않은 변경이 있습니다. 이 화면을 나가시겠습니까?"));
  expect(await page.evaluate(() => !!history.state?.unsavedGuard)).toBe(false);
  expect(writes).toEqual([]); expect(errors).toEqual([]);
});

for (const entry of ["직접 진입", "새로고침"]) test(`직원 사용 중지의 불분명 결과 ${entry} ←는 확인과 원래 결과 안내를 보존한다`, async ({ page }) => {
  const writes: string[] = [];
  await mockSeller(page, async (route, path) => {
    if (route.request().method() !== "GET") { writes.push(path); await json(route, { error: "unavailable" }, 503); return true; }
    return backReads(route, path);
  });
  await page.goto(`/seller/staff/${id(1)}?operation=disable&returnTo=${encodeURIComponent("/seller/staff?q=kept")}`);
  if (entry === "새로고침") await page.reload();
  await page.locator('section[aria-labelledby="staff-disable-title"]').getByRole("button", { name: "직원 계정 사용 중지", exact: true }).click();
  await expect(page.getByTestId("sd-unclear")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!history.state?.unsavedGuard)).toBe(true);
  const detail = page.url();
  page.once("dialog", dialog => void dialog.dismiss());
  await page.locator("main").getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(detail); await expect(page.getByTestId("sd-unclear")).toBeVisible();
  page.once("dialog", dialog => void dialog.accept());
  await page.locator("main").getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/staff\?q=kept$/);
  await expect(page.getByRole("status").filter({ hasText: "이전 사용 중지 요청이 처리되었을 수 있습니다" })).toBeVisible();
  expect(await page.evaluate(() => !!history.state?.unsavedGuard)).toBe(false);
  expect(writes).toEqual([`/api/seller/staff/${id(1)}/disable`]);
});
