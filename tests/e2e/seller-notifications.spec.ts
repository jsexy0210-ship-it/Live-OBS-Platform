import { expect, test, type Page } from "@playwright/test";
import { E2E_PREFIX, adminReplyInDb, cleanupPlatformE2eInDb, createNoticeInDb } from "./platformDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-130 알림 센터: 새 공지·문의 답변을 한 줄씩 보이고, 눌러 처리 화면으로 가며, 열면 공지는 읽음·문의 답변은 그 문의를 열어야 읽음이다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await cleanupPlatformE2eInDb();
});
test.afterAll(async () => {
  await cleanupPlatformE2eInDb();
});

async function login(page: Page, next: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

test("새 공지와 문의 답변이 안 읽음으로 보이고, 열면 공지는 읽음·답변은 문의를 열어야 읽음이며, 눌러 해당 화면으로 간다", async ({ page }) => {
  const noticeId = await createNoticeInDb("알림 공지");
  await login(page, "/seller/inquiries");
  const inquiryId = await page.evaluate(async (title) => {
    const r = await fetch("/api/seller/platform-inquiries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "OTHER", title, body: "내용" }) });
    return ((await r.json()) as { inquiry: { id: string } }).inquiry.id;
  }, `${E2E_PREFIX}알림 문의`);
  await adminReplyInDb(inquiryId, "확인했습니다.");

  await page.goto("/seller/notifications");
  await expect(page.getByRole("heading", { level: 1, name: "알림" })).toBeVisible();
  const notice = page.getByTestId("notif-row").filter({ hasText: `${E2E_PREFIX}알림 공지` });
  const reply = page.getByTestId("notif-row").filter({ hasText: `${E2E_PREFIX}알림 문의` });
  await expect(notice).toHaveAttribute("data-unread", "true");
  await expect(reply).toHaveAttribute("data-unread", "true");
  await expect(notice).toContainText("공지");
  await expect(reply).toContainText("문의 답변");
  await expect(page.getByTestId("notif-unread")).toBeVisible();

  // 연 것으로 남겼으니 새로 고치면 공지는 읽음, 문의 답변은 아직 안 읽음
  await page.reload();
  await expect(notice).toHaveAttribute("data-unread", "false");
  await expect(reply).toHaveAttribute("data-unread", "true");

  // 눌러서 문의를 열면 답변도 읽음
  await reply.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/seller/inquiries/${inquiryId}$`));
  await expect(page.getByTestId("inquiry-message")).toHaveCount(2);
  await page.goto("/seller/notifications");
  await expect(reply).toHaveAttribute("data-unread", "false");

  // 공지 알림은 공지 상세로
  await notice.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/seller/notices/${noticeId}$`));
});

test("입금 확인·결제 완료·재고 없음·반품 요청 알림은 서버 제목 그대로 종류 배지와 함께 보이고, 눌러 해당 화면으로 간다", async ({ page }) => {
  await login(page, "/seller/notifications");
  const now = new Date().toISOString();
  const items = [
    { id: "dp1", kind: "DEPOSIT_PENDING", title: "주문 12 입금 확인 필요", href: "/seller/orders/o12", createdAt: now, unread: true },
    { id: "op1", kind: "ORDER_PAID", title: "주문 13 결제 완료", href: "/seller/orders/o13", createdAt: now, unread: false },
    { id: "os1", kind: "OUT_OF_STOCK", title: "테스트 상품 재고 없음", href: "/seller/products/p1", createdAt: now, unread: true },
    { id: "rr1", kind: "RETURN_REQUESTED", title: "주문 14 반품 요청", href: "/seller/returns", createdAt: now, unread: true },
  ];
  await page.route("**/api/seller/notifications", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { items, unreadCount: 3 } }) : route.continue()));
  await page.goto("/seller/notifications");
  const row = (t: string) => page.getByTestId("notif-row").filter({ hasText: t });
  await expect(row("주문 12 입금 확인 필요")).toContainText("입금 확인");
  await expect(row("주문 13 결제 완료")).toContainText("결제 완료");
  await expect(row("주문 13 결제 완료")).toHaveAttribute("data-unread", "false");
  await expect(row("테스트 상품 재고 없음")).toContainText("재고 없음");
  await expect(row("주문 14 반품 요청")).toContainText("반품·교환");
  await expect(page.getByTestId("notif-unread")).toContainText("3건");
  await row("주문 14 반품 요청").getByRole("link").click();
  await expect(page).toHaveURL(/\/seller\/returns$/);
});
