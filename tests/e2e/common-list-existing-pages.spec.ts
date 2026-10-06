import { test, expect } from "@playwright/test";
// Actual Next routes, shell and production CSS. Only GET response data is supplied;
// these checks do not establish authentication or live database behavior.
const date = "2026-10-06T01:00:00.000Z";
const me = { sellerId: "test", userId: "test", isOwner: true, permissions: [], access: "paid", features: ["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"], shop: { name: "검수 쇼핑몰", slug: "test" }, user: { name: "검수", email: "test@example.com" }, trialEndsAt: null };
const responses: Record<string, unknown> = {
  "/api/seller/me": me,
  "/api/seller/platform-inquiries": { items: [{ id: "test", category: "OTHER", title: "테스트 문의", status: "OPEN", createdAt: date, lastMessageAt: date, lastReplyAt: null, hasNewReply: false }], counts: { all: 1, open: 1, answered: 0, closed: 0 }, newReplyCount: 0, avgFirstReplyMinutes: null, nextCursor: null },
  "/api/seller/platform-notices": { pinned: [], items: [{ id: "test", title: "테스트 공지", category: "FEATURE", publishedAt: date, createdAt: date, pinned: false, read: false, hasAttachment: false }], nextCursor: null, unreadCount: 1 },
  "/api/seller/broadcast/test": { broadcast: { id: "test", title: "테스트 방송", status: "ended", startedAt: date, endedAt: "2026-10-06T02:00:00.000Z", memo: null, hostName: "검수", layoutAspect: "16x9", timerSeconds: null }, summary: { orders: 1, paidOrders: 1, sales: 1000, completed: 1, cancelled: 0, hits: 1, avgOpenSeconds: 10, maxWaiting: 1 }, hourly: [], events: [{ at: date, kind: "connected", downSeconds: null, waiting: null }], orders: [{ id: "test", orderNo: "TEST-1", nickname: "검수", items: [{ productName: "시험 상품", optionName: "기본", quantity: 1, unitPrice: 1000 }], totalAmount: 1000, refundAmount: null, status: "PAID", createdAt: date, paidAt: date, completedAt: date }], nextCursor: null, hits: [{ id: "test", cardName: "시험 카드", note: null, nickname: "검수", order: null, createdAt: date }], externalOrders: [] },
};
test.use({ channel: "chrome" });
for (const [name, route] of [["inquiries", "/seller/inquiries"], ["notices", "/seller/notices"], ["broadcast", "/seller/broadcasts/test"]]) {
  for (const width of [1440, 1024, 390]) test(`existing ${name} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/seller/**", async request => {
      expect(request.request().method()).toBe("GET");
      await request.fulfill({ status: 200, json: responses[new URL(request.request().url()).pathname] ?? {} });
    });
    await page.goto(route);
    const grids = page.locator(".au-lt-wrap"); await expect(grids.first()).toBeVisible();
    const frames = await grids.evaluateAll(els => els.map(el => ({ border: getComputedStyle(el).borderTopWidth, radius: getComputedStyle(el).borderRadius, cardShadow: getComputedStyle(el.closest(".card")!).boxShadow })));
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) { expect(frame.border).toBe("0px"); expect(frame.radius).toBe("0px"); expect(frame.cardShadow).not.toBe("none"); }
    expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `tests/e2e/screenshots/common-list/existing-${name}-${width}.png`, fullPage: true });
  });
}
