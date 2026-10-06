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
  // 통합 화면(적립금·문의·리뷰)은 메뉴 한 항목이고, 화면 안 탭으로 나뉜다
  expect(await items("고객")).toEqual(["회원 목록", "회원 등급", "구매 제한", "회원에게 알림 보내기", "적립금", "문의 · 리뷰"]);
  expect(await items("마케팅")).toEqual(["쿠폰", "홈 배너", "이벤트 팝업", "쇼핑몰 공지 · 자주 묻는 질문"]);
});

test("취소 · 교환 · 반품은 한 메뉴이고, 하위 화면에서 부모 메뉴가 켜져 있으며 화면 안 탭으로 나뉜다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/orders/refund-requests");
  await expect(gnb(page).getByRole("link", { name: "주문", exact: true })).toHaveClass(/\bon\b/);
  await expect(lnb(page).getByRole("link", { name: "취소 · 교환 · 반품" })).toHaveAttribute("aria-current", "page");
  await expect(lnb(page).getByRole("link", { name: "전체 주문" })).not.toHaveAttribute("aria-current", "page");
  const tabs = page.getByRole("navigation", { name: "화면 탭" });
  await expect(tabs.getByRole("link", { name: "취소 · 환불" })).toHaveAttribute("aria-current", "page");
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
  const link = lnb(page).getByRole("link", { name: "문의 · 리뷰" });
  await expect(link).toHaveAttribute("href", "/seller/buyer-inquiries");
  await link.click();
  await expect(page).toHaveURL(/\/seller\/buyer-inquiries$/);
  await expect(gnb(page).getByRole("link", { name: "고객", exact: true })).toHaveClass(/\bon\b/);
  await expect(lnb(page).getByRole("link", { name: "문의 · 리뷰" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "화면 탭" }).getByRole("link", { name: "리뷰" })).toHaveAttribute("href", "/seller/reviews");
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
  await expect(dialog.getByRole("link", { name: "모두 보기" })).toHaveAttribute("href", "/seller/notifications");
  await page.mouse.click(300, 600);
  await expect(dialog).toHaveCount(0);
});

test("상품 그룹 「재고」 메뉴의 탭으로 「재입고 알림」(/seller/products/restock-alerts)이 연결된다(머리를 아직 안 쓰는 재고 화면은 경로 줄 아래 탭)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products");
  await expect(lnb(page).getByRole("link", { name: "재고" })).toHaveAttribute("href", "/seller/products/stock");
  await lnb(page).getByRole("link", { name: "재고" }).click();
  await expect(page.getByRole("navigation", { name: "화면 탭" }).getByRole("link", { name: "재입고 알림" })).toHaveAttribute("href", "/seller/products/restock-alerts");
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
  await login(page, "/seller/broadcast");
  await expect(lnb(page).getByRole("link", { name: "외부 채널 연결" })).toHaveAttribute("href", "/seller/youtube");
  await lnb(page).getByRole("link", { name: "외부 채널 연결" }).click();
  const tabs = page.getByRole("navigation", { name: "화면 탭" });
  await expect(tabs.getByRole("link")).toHaveText(["유튜브", "외부 쇼핑몰", "자동 연결"]);
  await expect(tabs.getByRole("link", { name: "외부 쇼핑몰" })).toHaveAttribute("href", "/seller/external-shops");
  await expect(tabs.getByRole("link", { name: "자동 연결" })).toHaveAttribute("href", "/seller/automation");
  // 시작하기는 메뉴에서 빠지고 홈 아래 화면이다(주소로 열어도 홈 대분류가 켜진다)
  await page.goto("/seller/onboarding");
  await expect(gnb(page).locator(".gnb-i.on")).toHaveText("홈");
});

test("자동 연결 메뉴는 대표자에게만 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/broadcast")}`);
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await page.waitForURL(/\/seller\//);
  await page.goto("/seller/settings/shop");
  await expect(page.getByRole("navigation", { name: "화면 탭" }).getByRole("link", { name: "자동 연결" })).toHaveCount(0);
  await expect(lnb(page).getByText("자동 연결")).toHaveCount(0);
});

test("화면이 생긴 설정·고객 메뉴가 연결된다: 검색 노출·적립금 탭(실제 지급 켜기)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/settings/shop");
  await expect(lnb(page).getByRole("link", { name: "검색 노출" })).toHaveAttribute("href", "/seller/settings/seo");
  await gnb(page).getByRole("link", { name: "고객", exact: true }).click();
  await lnb(page).getByRole("link", { name: "적립금" }).click();
  const tabs = page.getByRole("navigation", { name: "화면 탭" });
  await expect(tabs.getByRole("link", { name: "실제 지급 켜기" })).toHaveAttribute("href", "/seller/rewards/live-payout");
  await tabs.getByRole("link", { name: "실제 지급 켜기" }).click();
  await expect(page).toHaveURL(/\/seller\/rewards\/live-payout$/);
  await expect(tabs.getByRole("link", { name: "실제 지급 켜기" })).toHaveAttribute("aria-current", "page");
  await expect(lnb(page).getByRole("link", { name: "적립금" })).toHaveAttribute("aria-current", "page");
});
