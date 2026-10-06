import { test, expect } from "@playwright/test";
// Real Next routes and production CSS; GET data is fixed. No authentication or DB claim.
test.use({ channel: "chrome" });
const at = "2026-10-06T01:00:00.000Z";
const admin = { id: "test", name: "검수", email: "test@example.com", role: "SUPER_ADMIN" };
const seller = { sellerId: "test", userId: "test", isOwner: true, permissions: [], access: "paid", features: ["OVERLAY", "STORE_OPERATIONS"], shop: { name: "검수", slug: "test" }, user: { name: "검수", email: "test@example.com" }, trialEndsAt: null };
const count = { count: 1, amount: 1000, retrying: 0, overdue: 0, estimatedAmount: 1000 };
for (const route of ["/admin/partners?q=보존", "/admin/billing/invoices?q=보존", "/admin/partners/applications?q=보존", "/seller/inquiries?status=OPEN", "/seller/notices?q=보존"]) for (const width of [1440, 1024, 390]) {
  test(`${route} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: URL[] = [];
    await page.route("**/api/**", async req => {
      expect(req.request().method()).toBe("GET");
      const u = new URL(req.request().url()); requests.push(u);
      const nextCursor = u.searchParams.has("cursor") ? null : "next-test";
      let data: unknown = {};
      if (u.pathname === "/api/admin/me") data = admin;
      if (u.pathname === "/api/seller/me") data = seller;
      if (u.pathname === "/api/admin/sellers") data = { total: 250, summary: { total: 250, normal: 250 }, sellers: [{ id: "test", slug: "test", shopName: "검수", status: "ACTIVE", displayStatus: "NORMAL", seq: 1, plan: null, subscription: null, trialEndsAt: null, approvedAt: at, createdAt: at, representativeName: null, pg: { status: "NONE" }, live: false, ordersThisMonth: 0, memberCount: 0, lastActivityAt: null, payoutEnabled: false, noteCount: 0 }] };
      if (u.pathname === "/api/admin/billing/invoices") data = { range: { from: "2026-10-01", to: "2026-10-31" }, summary: { total: count, paid: count, failed: count, pending: count, refunded: count, scheduled: count }, total: 50, nextCursor, items: [{ id: "test", paymentId: "test", state: "PAID", at, amount: 1000, amountEstimated: false, kind: "PERIOD", seller: { id: "test", slug: "test", shopName: "검수" }, planName: "통합", periodStart: at, paymentMethod: null, receipt: "NOT_ISSUED", receiptUrl: null, failureReason: null, canRetry: false }] };
      if (u.pathname === "/api/admin/sellers/applications") data = { total: 50, nextCursor, chips: { all: 50, clear: 50, review: 0, supplement: 0, over48h: 0, today: 0 }, kpi: { pending: 50, needsReview: 0, clear: 50, supplement: 0, over48h: 0, receivedToday: 0, approvedToday: 0, autoApprovedToday: 0, rejectedToday: 0, avgHandlingHours: { thisWeek: null, lastWeek: null } }, industries: [], applications: [{ id: "test", slug: "test", shopName: "검수", state: "CLEAR", applicantName: "검수", applicantEmail: "test@example.com", businessNumber: null, industry: null, receivedAt: at, elapsedHours: 1, over48h: false, reasons: [], checks: [], checkedAt: null, supplement: null, license: null, businessAddress: null, channelUrl: null }] };
      if (u.pathname === "/api/seller/platform-inquiries") data = { items: [{ id: "test", category: "OTHER", title: "검수 문의", status: "OPEN", createdAt: at, lastMessageAt: at, lastReplyAt: null, hasNewReply: false }], counts: { all: 50, open: 50, answered: 0, closed: 0 }, newReplyCount: 0, avgFirstReplyMinutes: null, nextCursor };
      if (u.pathname === "/api/seller/platform-notices") data = { pinned: [], items: [{ id: "test", title: "검수 공지", category: "FEATURE", publishedAt: at, createdAt: at, pinned: false, read: false, hasAttachment: false }], nextCursor, unreadCount: 1 };
      await req.fulfill({ status: 200, json: data });
    });
    await page.goto(route);
    const nav = page.locator(".onq-pagination"); await expect(nav).toBeVisible();
    await expect(nav.getByRole("button", { name: "처음", exact: true })).toBeDisabled();
    if (route.startsWith("/admin/partners?")) {
      await nav.getByRole("button", { name: "마지막", exact: true }).click();
      await expect(nav.locator('[aria-current="page"]')).toHaveText("13");
      await expect(page).toHaveURL(/page=13/);
    } else {
      await expect(nav.getByRole("button", { name: "마지막", exact: true })).toHaveCount(0);
      await nav.getByRole("button", { name: "다음", exact: true }).click();
      await expect(nav.locator('[aria-current="page"]')).toHaveText("2");
      await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
      expect(requests.some(u => u.searchParams.get("cursor") === "next-test")).toBe(true);
    }
    expect(new URL(page.url()).searchParams.get(route.includes("inquiries") ? "status" : "q")).toBe(route.includes("inquiries") ? "OPEN" : "보존");
    const geometry = await nav.evaluate(el => { const r = el.getBoundingClientRect(); return [...el.querySelectorAll<HTMLElement>(".onq-page-control")].filter(e => getComputedStyle(e).display !== "none").map(e => { const b = e.getBoundingClientRect(); return { height: b.height, inside: b.left >= r.left && b.right <= r.right, margin: getComputedStyle(e).marginLeft }; }); });
    expect(geometry.every(g => g.height === (width < 768 ? 44 : 40) && g.inside && g.margin === "0px")).toBe(true);
    await nav.getByRole("button", { name: "처음", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(nav.locator('[aria-current="page"]')).toHaveText("1");
    await nav.screenshot({ path: `tests/e2e/screenshots/pagination/${route.split('?')[0].replaceAll('/', '-')}-${width}.png` });
  });
}
