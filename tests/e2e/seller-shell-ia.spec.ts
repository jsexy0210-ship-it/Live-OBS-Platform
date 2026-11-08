import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 파트너스 셸 IA 개편(2026-10-05): GNB 8개, LNB 「환불 요청」, 상단 「공지 · 문의」·「도우미」 링크,
// 1024px 겹침 없음, 서랍(1024 미만)이 열린 채 Back을 누르면 서랍부터 닫힘.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

const gnb = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });
const lnb = (page: Page) => page.getByRole("complementary", { name: "파트너스 메뉴" });
// 하위 화면(예전 화면 안 탭)이 있는 메뉴는 왼쪽 메뉴에서 제목 아래 하위 링크로 펼쳐진다(2026-10-06 대표님 결정: 페이지 이동용 탭은 왼쪽 사이드바)
const sub = (page: Page, menu: string) => lnb(page).getByRole("navigation", { name: menu, exact: true });

test("GNB는 8개이고 고객·마케팅·통계·설정 묶음에 메뉴가 들어 있다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products");
  await expect(gnb(page).locator(".gnb-i")).toHaveText(["홈", "방송", "주문", "상품", "고객", "마케팅", "통계", "설정"]);
  const items = async (name: string) => {
    await gnb(page).getByRole("link", { name, exact: true }).click();
    await expect(gnb(page).getByRole("link", { name, exact: true })).toHaveClass(/\bon\b/);
    await expect(lnb(page).locator(".lnb-sec.on .lnb-h")).toHaveText(name);
    return lnb(page).locator(".lnb-sec.on .lnb-i").allTextContents();
  };
  const branches = () => lnb(page).locator(".lnb-sec.on .lnb-parent").allTextContents();
  // 통합 화면(적립금·문의·리뷰)은 메뉴 한 항목이고, 하위 화면은 그 아래 링크로 나뉜다
  expect(await items("고객")).toEqual(["회원 목록", "회원 등급", "구매 제한"]);
  expect(await branches()).toEqual(["회원에게 알림 보내기", "적립금", "문의 · 리뷰"]);
  expect(await items("마케팅")).toEqual(["쿠폰", "홈 배너", "이벤트 팝업", "쇼핑몰 공지 · 자주 묻는 질문"]);
});

test("취소 · 교환 · 반품은 한 메뉴이고, 하위 화면에서 부모 메뉴가 켜져 있으며 화면 안 탭으로 나뉜다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/orders/refund-requests");
  await expect(gnb(page).getByRole("link", { name: "주문", exact: true })).toHaveClass(/\bon\b/);
  const tabs = sub(page, "취소 · 교환 · 반품");
  await expect(tabs.getByRole("link", { name: "취소 · 환불" })).toHaveAttribute("aria-current", "page");
  await expect(lnb(page).getByRole("link", { name: "전체 주문" })).not.toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "교환 · 반품" })).toHaveAttribute("href", "/seller/returns");
});

test("상단 「공지 · 문의」「도우미」는 링크로 열린다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products");
  const util = page.locator(".util-desk");
  await expect(util.getByRole("link", { name: "공지 · 문의" })).toHaveAttribute("href", "/seller/notices");
  await expect(util.getByRole("link", { name: "도우미" })).toHaveAttribute("href", "/seller/assistant");
  await util.getByRole("link", { name: "공지 · 문의" }).click();
  await expect(page).toHaveURL(/\/seller\/notices$/);
});

test("상단 유틸 화면은 GNB 선택 없이 자기 LNB를 쓴다(SA-LNB ⑤)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/notices");
  await expect(gnb(page).locator(".gnb-i.on")).toHaveCount(0);
  await expect(lnb(page).locator(".lnb-sec.on .lnb-h")).toHaveText("공지 · 문의");
  await expect(lnb(page).locator(".lnb-sec.on .lnb-i")).toHaveText(["공지사항", "내 문의"]);
  await expect(page.locator(".loc-bar .crumb")).toHaveText("공지 · 문의›공지사항");
  await page.goto("/seller/notifications");
  await expect(page.locator(".loc-bar .crumb")).toHaveText("공지 · 문의›알림");
  await page.goto("/seller/assistant");
  await expect(gnb(page).locator(".gnb-i.on")).toHaveCount(0);
  await expect(lnb(page).locator(".lnb-sec.on .lnb-h")).toHaveText("도우미");
  await expect(lnb(page).locator(".lnb-sec.on .lnb-i")).toHaveText(["도우미"]);
});

test("로그인하면 홈(/seller)으로 가고, GNB 「홈」은 링크로 홈을 켠다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === "/seller");
  await expect(gnb(page).getByRole("link", { name: "홈", exact: true })).toHaveAttribute("href", "/seller");
  await expect(gnb(page).locator(".gnb-i.on")).toHaveText("홈");
  await page.goto("/seller/products");
  await gnb(page).getByRole("link", { name: "홈", exact: true }).click();
  await expect(page).toHaveURL(/\/seller$/);
  await expect(page.getByRole("heading", { level: 1, name: "홈" })).toBeVisible();
});

for (const width of [1024, 1100, 1280, 1440]) {
  test(`${width}px에서 GNB 메뉴·검색·알림·상단 유틸이 겹치지 않고 잘리지 않는다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await login(page, "/seller/products");
    await expect(page.locator(".gnb-util")).toBeVisible();
    const boxes = await page.evaluate(() => {
      const r = (el: Element) => {
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, w: b.width };
      };
      const nav = document.querySelector(".gnb-nav")!;
      // 왼쪽에서 오른쪽 순서: 메뉴 → (쇼핑몰 이름) → 검색·알림 아이콘 → 상단 유틸. 숨겨진(폭 0) 것은 건너뛴다
      const seq = [".gnb-nav", ".gnb-shop", ".gnb-ic-wrap", ".gnb-ic-wrap:nth-of-type(2)", ".util-desk"]
        .map((q) => document.querySelector(q))
        .filter((el): el is Element => !!el)
        .map(r)
        .filter((x) => x.w > 0);
      const util = r(document.querySelector(".util-desk")!);
      return { seq, utilRight: util.right, vw: window.innerWidth, navScroll: nav.scrollWidth - nav.clientWidth > 1 };
    });
    for (let i = 1; i < boxes.seq.length; i++) expect(boxes.seq[i - 1].right, `${i}번째 요소가 앞 요소와 겹침`).toBeLessThanOrEqual(boxes.seq[i].left + 0.5);
    expect(boxes.utilRight, "상단 유틸이 화면 밖으로 잘림").toBeLessThanOrEqual(boxes.vw);
    expect(boxes.navScroll).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("서랍이 열린 채 Back을 누르면 페이지를 떠나지 않고 서랍만 닫힌다", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await login(page, "/seller/products");
  const before = page.url();
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.locator(".cs")).toHaveClass(/nav-open/);
  await page.goBack();
  await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
  expect(page.url()).toBe(before);
  // 닫기 버튼으로 닫으면 쌓인 기록도 없어져 Back이 이전 화면으로 간다
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("button", { name: "메뉴 닫기" }).click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".cs")).not.toHaveClass(/nav-open/);
  await page.goBack();
  await expect(page).not.toHaveURL(/\/seller\/products$/);
});

test("고객 그룹 「문의 · 리뷰」는 /seller/buyer-inquiries(문의 탭)로 연결되고 그 화면에서 켜져 있다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/members");
  const tabs = sub(page, "문의 · 리뷰");
  const inquiry = tabs.getByRole("link", { name: "문의", exact: true });
  await expect(inquiry).toHaveAttribute("href", "/seller/buyer-inquiries");
  await inquiry.click();
  await expect(page).toHaveURL(/\/seller\/buyer-inquiries$/);
  await expect(gnb(page).getByRole("link", { name: "고객", exact: true })).toHaveClass(/\bon\b/);
  await expect(tabs.getByRole("link", { name: "문의", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "리뷰", exact: true })).toHaveAttribute("href", "/seller/reviews");
});

test("상단 전역 검색: 상품을 찾아 이동하고, 결과가 없으면 안내하며, Esc로 닫힌다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/members");
  await page.getByRole("button", { name: "빠른 찾기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "전체 검색" });
  await expect(dialog.getByText("검색어를 입력해 주십시오.")).toBeVisible();
  await dialog.getByRole("searchbox").fill("탑로더");
  const hit = dialog.getByRole("region", { name: "상품" }).getByRole("link", { name: /탑로더 25장/ });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(/\/seller\/products\/[^/?]+$/);
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "빠른 찾기", exact: true }).click();
  await page.getByRole("dialog", { name: "전체 검색" }).getByRole("searchbox").fill("zzz없는검색어");
  await expect(page.getByText("「zzz없는검색어」 검색 결과가 없습니다.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "전체 검색" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "빠른 찾기", exact: true })).toBeFocused();
});

test("상단 알림: 종 버튼이 열리고(목록 또는 빈 안내), 바깥을 누르면 닫힌다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/members");
  const bell = page.getByRole("button", { name: /^알림/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const dialog = page.getByRole("dialog", { name: "알림" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/새 알림이 없습니다|공지|문의 답변|입금 확인|결제 완료|재고 없음|교환·반품/).first()).toBeVisible();
  await expect(dialog.getByRole("link", { name: "지난 알림 모두 보기" })).toHaveAttribute("href", "/seller/notifications");
  await page.mouse.click(300, 600);
  await expect(dialog).toHaveCount(0);
});

test("상품 그룹 「재고」 메뉴의 탭으로 「재입고 알림」(/seller/products/restock-alerts)이 연결된다(머리를 아직 안 쓰는 재고 화면은 경로 줄 아래 탭)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products");
  const stock = sub(page, "재고");
  await expect(stock.getByRole("link", { name: "재고 수정" })).toHaveAttribute("href", "/seller/products/stock");
  await expect(stock.getByRole("link", { name: "재입고 알림" })).toHaveAttribute("href", "/seller/products/restock-alerts");
});

test("모바일(390): 검색·알림 버튼이 보이고 패널이 화면 안에 열린다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await login(page, "/seller/members");
  await page.getByRole("button", { name: "빠른 찾기", exact: true }).click();
  const box = await page.getByRole("dialog", { name: "전체 검색" }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test("화면이 생긴 메뉴가 연결된다: 외부 채널 연결 탭(유튜브·외부 쇼핑몰·자동 연결)과 홈 아래 시작하기", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller");
  await gnb(page).getByRole("link", { name: "방송", exact: true }).click();
  const tabs = sub(page, "외부 채널 연결");
  await expect(tabs.getByRole("link")).toHaveText(["유튜브", "외부 쇼핑몰", "자동 연결"]);
  await expect(tabs.getByRole("link", { name: "유튜브" })).toHaveAttribute("href", "/seller/youtube");
  await tabs.getByRole("link", { name: "유튜브" }).click();
  await expect(page).toHaveURL(/\/seller\/youtube$/);
  await expect(tabs.getByRole("link", { name: "외부 쇼핑몰" })).toHaveAttribute("href", "/seller/external-shops");
  await expect(tabs.getByRole("link", { name: "자동 연결" })).toHaveAttribute("href", "/seller/automation");
  // 시작하기는 메뉴에서 빠지고 홈 아래 화면이다(주소로 열어도 홈 대분류가 켜진다)
  await page.goto("/seller/onboarding");
  await expect(gnb(page).locator(".gnb-i.on")).toHaveText("홈");
});

test("자동 연결 메뉴는 대표자에게만 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller")}`);
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await page.waitForURL(/\/seller$/);
  await page.goto("/seller/settings/shop");
  await expect(page.getByRole("navigation", { name: "화면 탭" }).getByRole("link", { name: "자동 연결" })).toHaveCount(0);
  await expect(lnb(page).getByText("자동 연결")).toHaveCount(0);
});

test("화면이 생긴 설정·고객 메뉴가 연결된다: 검색 노출·적립금 탭(실제 지급 켜기)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/settings/shop");
  await expect(lnb(page).getByRole("link", { name: "검색 노출" })).toHaveAttribute("href", "/seller/settings/seo");
  await gnb(page).getByRole("link", { name: "고객", exact: true }).click();
  const tabs = sub(page, "적립금");
  await expect(tabs.getByRole("link", { name: "실제 지급 켜기" })).toHaveAttribute("href", "/seller/rewards/live-payout");
  await tabs.getByRole("link", { name: "실제 지급 켜기" }).click();
  await expect(page).toHaveURL(/\/seller\/rewards\/live-payout$/);
  await expect(tabs.getByRole("link", { name: "실제 지급 켜기" })).toHaveAttribute("aria-current", "page");
});

test("설정 「주문 · 배송 설정」 하위에 「배송 자동화」가 세 번째 하위 화면으로 있고 그 주소에서 선택 표시된다", async ({ page }) => {
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await login(page, "/seller/settings/shipping-automation");
    const tabs = sub(page, "주문 · 배송 설정");
    await expect(tabs.locator(".lnb-sub-i")).toHaveText(["주문 설정", "배송 설정", "배송 자동화"]);
    await expect(tabs.getByRole("link", { name: "배송 자동화" })).toHaveAttribute("href", "/seller/settings/shipping-automation");
    await expect(tabs.getByRole("link", { name: "배송 자동화" })).toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: `tests/e2e/screenshots/SA-082-lnb-tab-${width}.png` });
  }
});

test("상단 알림 패널은 정본(SA-130) 구조: 머리·안내·분류 칩·오늘/이전 묶음·종류 태그·지난 알림 모두 보기", async ({ page }) => {
  const now = new Date();
  const at = (h: number, dayOffset: number) => {
    const d = new Date(now.getTime() - dayOffset * 86_400_000);
    d.setUTCHours(h, 10, 0, 0);
    return dayOffset === 0 ? new Date(now.getTime() - h * 60_000).toISOString() : d.toISOString();
  };
  const items = [
    { id: "a", kind: "CHARGE_SHORTAGE", title: "알림톡 충전금이 부족합니다", href: "/seller/settings/message-balance", createdAt: at(10, 0), unread: true },
    { id: "b", kind: "DEPOSIT_PENDING", title: "밤하늘 님 주문 입금 확인 필요", href: "/seller/orders/1", createdAt: at(30, 0), unread: true },
    { id: "c", kind: "ORDER_PAID", title: "레인보우 님 주문 결제 완료", href: "/seller/orders/2", createdAt: at(50, 0), unread: false },
    { id: "d", kind: "OUT_OF_STOCK", title: "스타라이트 케이스 재고 없음", href: "/seller/products/3", createdAt: at(70, 0), unread: true },
    { id: "e", kind: "NOTICE", title: "서비스 점검 안내", href: "/seller/notices", createdAt: at(1, 1), unread: false },
  ];
  await page.route("**/api/seller/notifications", (route) => route.fulfill({ json: { items, unreadCount: 3 } }));
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await login(page, "/seller/members");
    await page.getByRole("button", { name: /^알림/ }).click();
    const dialog = page.getByRole("dialog", { name: "알림" });
    await expect(dialog.locator(".np-h")).toContainText("읽지 않은 알림 3건");
    await expect(dialog.getByRole("link", { name: "설정", exact: true })).toHaveAttribute("href", "/seller/account");
    await expect(dialog.locator(".np-guide")).toContainText("누르면 해당 화면으로 갑니다");
    await expect(dialog.getByRole("group", { name: "분류" }).getByRole("button")).toHaveText(["전체", "결제 · 환불", "발송 · 잔액", "재고", "공지"]);
    await expect(dialog.locator(".np-gh")).toHaveText(["오늘", "이전"]);
    await expect(dialog.locator(".np-tag")).toHaveText(["잔액", "입금", "결제", "재고", "공지"]);
    expect(Math.round((await dialog.boundingBox())!.width)).toBe(420);
    await dialog.getByRole("button", { name: "결제 · 환불" }).click();
    await expect(dialog.locator(".np-i")).toHaveCount(2);
    await dialog.getByRole("button", { name: "재고" }).click();
    await expect(dialog.locator(".np-i")).toHaveCount(1);
    await dialog.getByRole("button", { name: "전체" }).click();
    await expect(dialog.getByRole("link", { name: "지난 알림 모두 보기" })).toHaveAttribute("href", "/seller/notifications");
    await page.screenshot({ path: `tests/e2e/screenshots/SA-130-dropdown-${width}.png` });
  }
});
