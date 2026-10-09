import { test, expect } from "@playwright/test";
// Actual Next routes, shell and production CSS. Only GET response data is supplied;
// these checks do not establish authentication or live database behavior.
const date = "2026-10-06T01:00:00.000Z";
const me = { sellerId: "test", userId: "test", isOwner: true, permissions: [], access: "paid", features: ["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"], shop: { name: "검수 쇼핑몰", slug: "test" }, user: { name: "검수", email: "test@example.com" }, trialEndsAt: null };
const responses: Record<string, unknown> = {
  "/api/seller/me": me,
  "/api/seller/categories": { categories: [] },
  "/api/seller/products": { products: [{ id: "test", code: "TEST", name: "테스트 상품", description: null, price: 1000, status: "ON_SALE", stockDeductMode: "PAYMENT", sortOrder: 0, createdAt: date, options: [{ id: "test", name: "기본", priceDelta: 0, stock: 10, sku: null, sortOrder: 0 }] }], nextCursor: null },
  "/api/seller/platform-inquiries": { items: [{ id: "test", category: "OTHER", title: "테스트 문의", status: "OPEN", createdAt: date, lastMessageAt: date, lastReplyAt: null, hasNewReply: false }], counts: { all: 1, open: 1, answered: 0, closed: 0 }, newReplyCount: 0, avgFirstReplyMinutes: null, nextCursor: null },
  "/api/seller/platform-notices": { pinned: [], items: [{ id: "test", title: "테스트 공지", category: "FEATURE", publishedAt: date, createdAt: date, pinned: false, read: false, hasAttachment: false }], nextCursor: null, unreadCount: 1 },
  "/api/seller/broadcast/test": { broadcast: { id: "test", title: "테스트 방송", status: "ended", startedAt: date, endedAt: "2026-10-06T02:00:00.000Z", memo: null, hostName: "검수", layoutAspect: "16x9", timerSeconds: null }, summary: { orders: 1, paidOrders: 1, sales: 1000, completed: 1, cancelled: 0, hits: 1, avgOpenSeconds: 10, maxWaiting: 1 }, hourly: [], events: [{ at: date, kind: "connected", downSeconds: null, waiting: null }], orders: [{ id: "test", orderNo: "TEST-1", nickname: "검수", items: [{ productName: "시험 상품", optionName: "기본", quantity: 1, unitPrice: 1000 }], totalAmount: 1000, refundAmount: null, status: "PAID", createdAt: date, paidAt: date, completedAt: date }], nextCursor: null, hits: [{ id: "test", cardName: "시험 카드", note: null, nickname: "검수", order: null, createdAt: date }], externalOrders: [] },
};
test.use({ channel: "chrome" });
for (const [name, route] of [["inquiries", "/seller/inquiries"], ["notices", "/seller/notices"], ["broadcast", "/seller/broadcasts/test"], ["products", "/seller/products"]]) {
  for (const width of [1440, 1024, 390]) test(`existing ${name} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/seller/**", async request => {
      expect(request.request().method()).toBe("GET");
      await request.fulfill({ status: 200, json: responses[new URL(request.request().url()).pathname] ?? {} });
    });
    await page.goto(route);
    const grids = page.locator(".au-lt-wrap"); await expect(grids.first()).toBeAttached();
    if (name === "products") {
      // SA-011 / DS-PANEL: search and list header stay outside the table frame.
      const search = page.getByRole("search", { name: "목록 조건" });
      const list = page.locator(".au-list-section");
      const grid = list.getByRole("region", { name: "상품 목록 표" });
      await expect(search).toBeVisible();
      await expect(search).toHaveCSS("border-radius", "12px");
      expect(await search.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
      await expect(list).toHaveCSS("border-top-width", "0px");
      await expect(list).toHaveCSS("border-radius", "0px");
      await expect(list).toHaveCSS("box-shadow", "none");
      await expect(list.locator(":scope > .au-lh")).toBeVisible();
      await expect(grid).toHaveClass(/au-list-grid/);
      await expect(grid).toHaveCSS("border-top-width", "1px");
      await expect(grid).toHaveCSS("border-radius", "12px");
      await expect(grid.locator(".au-sb, .au-lh, .onq-pagination")).toHaveCount(0);
      await expect(search.locator(".au-lt-wrap")).toHaveCount(0);
      if (width === 390) {
        await expect(grid).toBeHidden();
        await expect(list.getByTestId("product-card")).toBeVisible();
      } else {
        await expect(grid).toBeVisible();
        await expect(list.getByTestId("product-card")).toBeHidden();
      }
    } else {
      await expect(grids.first()).toBeVisible();
      for (const grid of await grids.all()) {
        await expect(grid).toHaveCSS("border-top-width", "0px");
        await expect(grid).toHaveCSS("border-radius", "0px");
        const card = grid.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' card ')][1]");
        await expect(card).toHaveCount(1);
        expect(await card.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
      }
    }
    expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(width);
    if (process.env.E2E_SCREENSHOTS !== "0") await page.screenshot({ path: `tests/e2e/screenshots/common-list/existing-${name}-${width}.png`, fullPage: true });
  });
}
