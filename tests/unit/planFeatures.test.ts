import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_FEATURES, planFeatures } from "../../lib/server/billing/features";

// ONQ 1-B 기능 권한(ARCHITECTURE 4.8.0) 경로 목록 검사. 새 판매자·공개·구매자 경로를 만들면 아래 표에 넣어야 통과한다.
const API = join(__dirname, "../../app/api");
const SHOP_PAGES_DIR = join(__dirname, "../../app/(shop)");

function filesNamed(dir: string, file: string, root: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return filesNamed(p, file, root);
    return name === file ? [relative(root, p).slice(0, -(file.length + 1))] : [];
  });
}
const routeFiles = (dir: string) => filesNamed(dir, "route.ts", dir);

// 판매자 API → 요구하는 기능 권한(lib/server/authz/guards.ts SellerRouteFeature). 가드를 부르지 않는 경로는 null.
const SELLER_ROUTES: Record<string, string | null> = {
  "seller/auth/login": null,
  "seller/auth/logout": null,
  "seller/find-id/accounts": null,
  "seller/find-id/confirm": null,
  "seller/find-id/resend": null,
  "seller/find-id/reset": null,
  "seller/find-id/start": null,
  "seller/password-reset/complete": null,
  "seller/password-reset/confirm": null,
  "seller/password-reset/resend": null,
  "seller/password-reset/start": null,
  "seller/password-reset/verify": null,
  // 본인확인 다시 받기·확인은 시작(ACCOUNT)한 흐름의 쿠키로 쓰고, 기능 권한(ACCOUNT)은 identityStepRoute가 기록의 쇼핑몰로 다시 본다
  "seller/me/identity/confirm": null,
  "seller/me/identity/resend": null,
  "seller/me": "BILLING",
  "seller/subscription": "BILLING",
  "seller/subscription/card": "BILLING",
  "seller/subscription/cancel": "BILLING",
  "seller/subscription/plan": "BILLING",
  "seller/subscription/plan/preview": "BILLING",
  "seller/message-balance": "BILLING",
  "seller/message-balance/consent": "BILLING",
  "seller/message-balance/ledger": "BILLING",
  "seller/message-balance/charges": "BILLING",
  "seller/me/identity": "ACCOUNT",
  "seller/me/identity/link": "ACCOUNT",
  "seller/me/identity/start": "ACCOUNT",
  "seller/staff": "ACCOUNT",
  "seller/staff/[userId]": "ACCOUNT",
  "seller/staff/[userId]/disable": "ACCOUNT",
  "seller/staff/[userId]/password": "ACCOUNT",
  "seller/staff/[userId]/permissions": "ACCOUNT",
  "seller/orders": "ORDER_FOLLOWUP",
  "seller/orders/[orderId]": "ORDER_FOLLOWUP",
  "seller/orders/[orderId]/cancel": "ORDER_FOLLOWUP",
  "seller/orders/[orderId]/deliver": "ORDER_FOLLOWUP",
  "seller/orders/[orderId]/refund": "ORDER_FOLLOWUP",
  "seller/orders/[orderId]/refund/preview": "ORDER_FOLLOWUP",
  "seller/orders/[orderId]/unconfirm": "ORDER_FOLLOWUP",
  "seller/orders/[orderId]/reconfirm": "ORDER_FOLLOWUP",
  "seller/orders/[orderId]/ship": "ORDER_FOLLOWUP",
  "seller/purchase-restrictions": "ORDER_FOLLOWUP",
  "seller/shipments": "ORDER_FOLLOWUP",
  "seller/shipments/deliver": "ORDER_FOLLOWUP",
  "seller/members": "ORDER_FOLLOWUP",
  "seller/members/[memberId]": "ORDER_FOLLOWUP",
  "seller/reward-balances": "ORDER_FOLLOWUP",
  "seller/reward-ledger": "ORDER_FOLLOWUP",
  "seller/purchase-restrictions/[buyerMemberId]/lift": "ORDER_FOLLOWUP",
  "seller/coupons": "STORE_OPERATIONS",
  "seller/member-grades": "STORE_OPERATIONS",
  "seller/member-grades/[gradeId]": "STORE_OPERATIONS",
  "seller/member-grades/recalc": "STORE_OPERATIONS",
  "seller/member-grades/members/[memberId]": "STORE_OPERATIONS",
  "seller/returns": "ORDER_FOLLOWUP",
  "seller/returns/[id]": "ORDER_FOLLOWUP",
  "seller/returns/[id]/accept": "ORDER_FOLLOWUP",
  "seller/returns/[id]/reject": "ORDER_FOLLOWUP",
  "seller/returns/[id]/receive": "ORDER_FOLLOWUP",
  "seller/returns/[id]/exchange": "ORDER_FOLLOWUP",
  "seller/returns/[id]/refund": "ORDER_FOLLOWUP",
  "seller/returns/images/[imageId]": "ORDER_FOLLOWUP",
  "seller/reviews": "STORE_OPERATIONS",
  "seller/reviews/[reviewId]": "STORE_OPERATIONS",
  "seller/reviews/[reviewId]/reply": "STORE_OPERATIONS",
  "seller/reviews/[reviewId]/hide": "STORE_OPERATIONS",
  "seller/reviews/[reviewId]/publish": "STORE_OPERATIONS",
  "seller/reviews/policy": "STORE_OPERATIONS",
  "seller/reviews/images/[imageId]": "STORE_OPERATIONS",
  "seller/coupons/[couponId]": "STORE_OPERATIONS",
  "seller/coupons/[couponId]/grant": "STORE_OPERATIONS",
  "seller/coupons/products": "STORE_OPERATIONS",
  "seller/broadcast/start": "OVERLAY",
  "seller/broadcast/end": "OVERLAY",
  "seller/overlay/token": "OVERLAY",
  "seller/overlay/layout": "OVERLAY",
  "seller/overlay/layout/reset": "OVERLAY",
  "seller/overlay/templates": "OVERLAY",
  "seller/overlay/templates/[templateId]": "OVERLAY",
  "seller/queue": "OVERLAY",
  "seller/queue/[itemId]/[action]": "OVERLAY",
  "seller/queue/reorder": "OVERLAY",
  "seller/queue/version": "OVERLAY",
  "seller/stream": "OVERLAY",
  "seller/member-policy": "STORE_OPERATIONS",
  "seller/order-policy": "STORE_OPERATIONS",
  "seller/payments/bank-account": "STORE_OPERATIONS", // 무통장 입금 계좌
  "seller/payments/deposits": "ORDER_FOLLOWUP", // 입금 대기 목록(잠금 중에도 이미 받은 주문 처리)
  "seller/payments/deposits/confirm": "ORDER_FOLLOWUP", // 입금 확인
  "seller/products": "STORE_OPERATIONS",
  "seller/products/[productId]": "STORE_OPERATIONS",
  "seller/products/bulk": "STORE_OPERATIONS",
  "seller/categories": "STORE_OPERATIONS",
  "seller/categories/[categoryId]": "STORE_OPERATIONS",
  "seller/categories/order": "STORE_OPERATIONS",
  "seller/categories/[categoryId]/products": "STORE_OPERATIONS",
  "seller/products/[productId]/categories": "STORE_OPERATIONS",
  "seller/products/[productId]/images": "STORE_OPERATIONS",
  "seller/products/[productId]/detail": "STORE_OPERATIONS",
  "seller/display": "STORE_OPERATIONS",
  "seller/display/sections": "STORE_OPERATIONS",
  "seller/display/recommended": "STORE_OPERATIONS",
  "seller/display/settings": "STORE_OPERATIONS",
  "seller/products/[productId]/images/order": "STORE_OPERATIONS",
  "seller/products/[productId]/images/[imageId]": "STORE_OPERATIONS",
  "seller/products/[productId]/event": "STORE_OPERATIONS",
  "seller/products/[productId]/options": "STORE_OPERATIONS",
  "seller/products/[productId]/options/[optionId]": "STORE_OPERATIONS",
  "seller/products/[productId]/options/[optionId]/stock-adjust": "STORE_OPERATIONS",
  "seller/products/options": "STORE_OPERATIONS",
  "seller/products/stock-movements": "STORE_OPERATIONS",
  "seller/reward-policy": "STORE_OPERATIONS",
  "seller/share-preview": "STORE_OPERATIONS",
  "seller/shipping-policy": "STORE_OPERATIONS",
  "seller/notices": "STORE_OPERATIONS",
  "seller/platform-notices": "BILLING", // 플랫폼 공지(SA-111·112): 잠김·정지 중에도 본다
  "seller/platform-notices/[noticeId]": "BILLING",
  "seller/notices/[noticeId]": "STORE_OPERATIONS",
  "seller/notices/faq-order": "STORE_OPERATIONS",
  "seller/shop-content/banners": "STORE_OPERATIONS",
  "seller/shop-content/banners/[bannerId]": "STORE_OPERATIONS",
  "seller/shop-content/banners/reorder": "STORE_OPERATIONS",
  "seller/shop-content/popups": "STORE_OPERATIONS",
  "seller/shop-content/popups/[popupId]": "STORE_OPERATIONS",
  "seller/shop-content/popups/reorder": "STORE_OPERATIONS",
  "seller/shop-content/images": "STORE_OPERATIONS",
  "seller/shop-content/images/[imageId]": "STORE_OPERATIONS",
  "seller/shop-content/logo": "STORE_OPERATIONS",
  "seller/shop-content/logo/image": "STORE_OPERATIONS",
  "seller/broadcast/[broadcastId]": "OVERLAY",
  "seller/broadcast/history": "OVERLAY",
  "seller/broadcast/summary": "OVERLAY",
  "seller/youtube": "OVERLAY",
  "seller/youtube/channel": "OVERLAY",
  "seller/youtube/live": "OVERLAY",
  "seller/youtube/live/find": "OVERLAY",
  "seller/youtube/live/chat": "OVERLAY",
  "seller/youtube/live/chat-matches": "OVERLAY",
  "seller/youtube/live/chat-status": "OVERLAY",
  "seller/youtube/settings": "OVERLAY",
  "seller/youtube/usage": "OVERLAY",
  "seller/youtube/chats": "OVERLAY",
  "seller/hit-cards": "OVERLAY",
  "seller/hit-cards/[hitCardId]": "OVERLAY",
  "seller/stats/broadcasts": "OVERLAY",
  "seller/stats/members": "STORE_OPERATIONS",
  "seller/stats/orders": "STORE_OPERATIONS",
  "seller/stats/overview": "STORE_OPERATIONS",
  "seller/stats/products": "STORE_OPERATIONS",
  "seller/stats/sales": "STORE_OPERATIONS",
};

// 공개·구매자 경로(ARCHITECTURE 4.8.0 표): 기능 권한이 없을 때 막는지. 막는 검사는 lib 쪽(shopOpen·createOrder·resolveOverlayToken)이나
// 라우트에 있고, 동작은 tests/integration/planFeatures.test.ts가 경로마다 확인한다.
const PUBLIC_ROUTES: Record<string, "STORE_OPERATIONS" | "OVERLAY" | "OPEN"> = {
  "shop/[slug]/orders": "STORE_OPERATIONS", // POST만 막음, GET(내 주문)은 열림
  "shop/[slug]/order-consent": "STORE_OPERATIONS",
  "shop/[slug]/signup": "STORE_OPERATIONS",
  "shop/[slug]/signup/verification": "STORE_OPERATIONS",
  "shop/[slug]/signup/verification/resend": "STORE_OPERATIONS",
  "shop/[slug]/signup/verification/confirm": "STORE_OPERATIONS",
  "shop/[slug]/share": "STORE_OPERATIONS",
  "shop/[slug]/og.png": "STORE_OPERATIONS",
  "shop/[slug]/shop-content": "STORE_OPERATIONS", // 홈 배너·이벤트 팝업
  "shop/[slug]/shop-content/images/[imageId]": "STORE_OPERATIONS",
  "shop/[slug]/coupons/code": "STORE_OPERATIONS", // 쿠폰 받기(코드·내려받기)는 shopOpen으로 막음
  "shop/[slug]/coupons/[couponId]/download": "STORE_OPERATIONS",
  "shop/[slug]/coupons": "OPEN", // 내 쿠폰함(받은 쿠폰 조회는 열고, 받을 수 있는 쿠폰은 운영 중일 때만)
  "shop/[slug]/categories": "STORE_OPERATIONS", // 카테고리 메뉴(SA-015)
  "shop/[slug]/shop-content/logo": "STORE_OPERATIONS", // 쇼핑몰 로고(없으면 404, 화면은 첫 글자)
  "shop/[slug]/returns": "STORE_OPERATIONS", // 교환·반품 신청(POST는 shopOpen으로 막고, GET 내 신청 조회는 잠긴 쇼핑몰에서도 열림)
  "shop/[slug]/returns/[id]/cancel": "STORE_OPERATIONS",
  "shop/[slug]/returns/[id]/ship-back": "STORE_OPERATIONS",
  "shop/[slug]/returns/images": "STORE_OPERATIONS",
  "shop/[slug]/returns/images/[imageId]": "OPEN", // 내가 올린 신청 사진
  "shop/[slug]/reviews": "OPEN", // 내 리뷰(받은 답글·숨김 사유는 잠긴 쇼핑몰에서도 본다)
  "shop/[slug]/reviews/[reviewId]": "OPEN", // 내 리뷰 고치기·지우기
  "shop/[slug]/reviews/images/[imageId]": "OPEN", // 내가 올린 사진
  "shop/[slug]/reviews/items/[orderItemId]": "STORE_OPERATIONS", // 리뷰 쓰기(POST는 shopOpen으로 막음)
  "shop/[slug]/reviews/images": "STORE_OPERATIONS",
  "shop/[slug]/reviews/[reviewId]/report": "STORE_OPERATIONS",
  "shop/[slug]/reviews/public-images/[imageId]": "STORE_OPERATIONS",
  "shop/[slug]/home": "STORE_OPERATIONS", // 홈 진열(SA-016)
  "shop/[slug]/products": "STORE_OPERATIONS", // 구매자 상품 목록(운영 중 쇼핑몰만)
  "shop/[slug]/products/[productId]": "STORE_OPERATIONS", // 구매자 상품 상세
  "shop/[slug]/products/[productId]/reviews": "STORE_OPERATIONS",
  "shop/[slug]/products/[productId]/images/[imageId]": "STORE_OPERATIONS", // 상품 사진(보이는 상품만)
  "shop/[slug]/orders/[orderId]": "OPEN",
  "shop/[slug]/payments": "STORE_OPERATIONS",
  "shop/[slug]/payments/bank-transfer": "STORE_OPERATIONS", // 무통장 입금 선택(shopOpenForPayment로 막음) // 주문 카드 결제 시작(startPayment가 주문 생성과 같은 조건으로 막음)
  "shop/[slug]/payments/shipping-preview": "STORE_OPERATIONS", // 배송비 미리보기(shopOpenForPayment로 막음)
  "shop/[slug]/auth/login": "OPEN",
  "shop/[slug]/auth/logout": "OPEN",
  "shop/[slug]/addresses": "OPEN",
  "shop/[slug]/addresses/[addressId]": "OPEN",
  "shop/[slug]/cart": "STORE_OPERATIONS", // 장바구니: 담기(POST)는 shopOpen으로 막음, 목록·선택 삭제는 열림
  "shop/[slug]/cart/[itemId]": "STORE_OPERATIONS", // 수량 변경(PATCH)은 shopOpen으로 막음, 한 줄 삭제는 열림
  "shop/[slug]/cart/checkout": "STORE_OPERATIONS", // 주문서로 넘기기(shopOpen으로 막음)
  "shop/[slug]/cart/count": "OPEN", // 머리 배지 개수
  "shop/[slug]/wishlist": "STORE_OPERATIONS", // 찜: 찜하기(POST)는 shopOpen으로 막음, 목록은 열림
  "shop/[slug]/wishlist/[productId]": "OPEN", // 찜 빼기
  "shop/[slug]/notices": "STORE_OPERATIONS", // 쇼핑몰 공지(운영 중이 아니면 404)
  "shop/[slug]/notices/[noticeId]": "STORE_OPERATIONS",
  "shop/[slug]/faqs": "STORE_OPERATIONS",
  "shop/[slug]/me/marketing-consent": "OPEN",
  "shop/[slug]/me/withdraw": "OPEN",
  "shop/[slug]/me/rewards": "OPEN", // 내 적립금 잔액(탈퇴 전 확인, #180)
  "shop/[slug]/me/rejoin-retention-consent": "OPEN", // 재가입 제한 정보 보관 동의 철회(언제든, #177)
  "overlay/[token]/state": "OVERLAY",
  "overlay/[token]/layout": "OVERLAY",
  "overlay/[token]/version": "OVERLAY",
  "overlay/[token]/stream": "OVERLAY",
};

// 서버 렌더 쇼핑몰 화면(ARCHITECTURE 4.8.0 ③). 「새 거래 시작」 화면은 스토어 운영 권한이 없으면 폼·구매 버튼 없이 안내 화면을 그린다.
// 판정은 shopOpen(운영 중·잠김·스토어 운영 권한)이 하고, 렌더 결과는 tests/integration/planFeatures.test.ts가 확인한다.
const SHOP_PAGES: Record<string, "STORE_OPERATIONS" | "OPEN"> = {
  "shop/[slug]": "STORE_OPERATIONS", // 쇼핑몰 홈(홈 배너·이벤트 팝업)
  "shop/[slug]/signup": "STORE_OPERATIONS",
  "shop/[slug]/reviews": "OPEN", // SH-029 내 리뷰(받은 답글·숨김 사유는 잠긴 쇼핑몰에서도)
  "shop/[slug]/reviews/write": "STORE_OPERATIONS", // SH-029 리뷰 쓰기
  "shop/[slug]/coupons": "OPEN", // SH-028 내 쿠폰함: 잠긴 쇼핑몰도 받은 쿠폰은 읽기 전용(받기는 API에서 막음)
  "shop/[slug]/products": "STORE_OPERATIONS", // SH-002 전체 상품(상품 격자)
  "shop/[slug]/search": "STORE_OPERATIONS", // SH-002 상품 검색
  "shop/[slug]/products/[productId]": "STORE_OPERATIONS", // SH-003 상품 상세: shopOpen으로 막고, 막히면 안내 화면
  "shop/[slug]/login": "OPEN", // SH-010 로그인: 잠긴 쇼핑몰에서도 받은 쿠폰·알림 설정에 들어갈 수 있게 연다
  "shop/[slug]/me": "OPEN", // SH-020 내 정보(메뉴 링크만)
  "shop/[slug]/cart": "STORE_OPERATIONS", // SH-004 장바구니: shopOpen으로 막고, 막히면 안내 화면
  "shop/[slug]/checkout": "STORE_OPERATIONS", // SH-005 주문서: shopOpen으로 막고, 막히면 안내 화면
  "shop/[slug]/orders/[orderId]": "OPEN", // SH-007 주문 완료·상세: 기존 주문 조회는 잠긴 쇼핑몰에서도 열림(API와 같은 기준)
  "shop/[slug]/wishlist": "OPEN", // SH-034 찜: 목록·빼기는 잠긴 쇼핑몰에서도 열림(찜하기만 API가 막음)
  "shop/[slug]/orders": "OPEN", // 주문 조회 준비 중 안내(기능 없음)
  "shop/[slug]/help": "STORE_OPERATIONS", // SH-030 고객센터: 공지·FAQ API가 운영 중인 쇼핑몰만 열어 줌 → shopOpen으로 막고, 막히면 안내 화면
  "shop/[slug]/help/notices/[noticeId]": "STORE_OPERATIONS", // 공지 상세(같은 기준)
  "shop/[slug]/me/notifications": "OPEN", // SH-025 알림 설정: 마케팅 수신 철회는 잠긴 쇼핑몰에서도 연다(API me/marketing-consent와 같은 기준)
};

describe("플랜 → 기능 권한 표", () => {
  it("오버레이 전용 2종, 통합·STANDARD 3종, 모르는 플랜은 없음", () => {
    const open = { firstPaymentConfirmed: true, hadTrial: false };
    expect(planFeatures("OVERLAY_ONLY", open)).toEqual(["OVERLAY", "EXTERNAL_INTEGRATION"]);
    expect(planFeatures("INTEGRATED", open)).toEqual(["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"]);
    expect(planFeatures("STANDARD", { firstPaymentConfirmed: false, hadTrial: false })).toEqual(PLAN_FEATURES.STANDARD);
    expect(planFeatures("NOPE", open)).toEqual([]);
  });

  it("통합은 첫 결제 확정 전이면 없음(체험을 받은 적 있는 이전 판매자는 잠금 규칙을 따름)", () => {
    expect(planFeatures("INTEGRATED", { firstPaymentConfirmed: false, hadTrial: false })).toEqual([]);
    expect(planFeatures("INTEGRATED", { firstPaymentConfirmed: false, hadTrial: true })).toHaveLength(3);
    expect(planFeatures("OVERLAY_ONLY", { firstPaymentConfirmed: false, hadTrial: false })).toHaveLength(2);
  });
});

describe("경로 목록 검사", () => {
  const all = routeFiles(API);

  it("판매자 API는 모두 표에 있고, 가드마다 표의 기능 권한을 넘긴다", () => {
    const seller = all.filter((r) => r.startsWith("seller/"));
    expect(seller.sort()).toEqual(Object.keys(SELLER_ROUTES).sort());
    for (const route of seller) {
      const src = readFileSync(join(API, route, "route.ts"), "utf8");
      const calls = src.match(/requireSeller\([^;]*/g) ?? [];
      const want = SELLER_ROUTES[route];
      if (want === null) {
        expect(calls, route).toEqual([]);
        continue;
      }
      expect(calls.length, route).toBeGreaterThan(0);
      for (const call of calls) expect(call.match(/feature: "([A-Z_]+)"/)?.[1], `${route}: ${call}`).toBe(want);
    }
  });

  it("쇼핑몰 화면은 모두 표에 있고, 막는 화면은 shopOpen으로 판정한다", () => {
    const pages = filesNamed(SHOP_PAGES_DIR, "page.tsx", SHOP_PAGES_DIR);
    expect(pages.sort()).toEqual(Object.keys(SHOP_PAGES).sort());
    for (const page of pages) {
      if (SHOP_PAGES[page] !== "STORE_OPERATIONS") continue;
      expect(readFileSync(join(SHOP_PAGES_DIR, page, "page.tsx"), "utf8"), page).toMatch(/shopOpen\(/);
    }
  });

  it("공개·구매자 경로는 모두 표에 있다", () => {
    const pub = all.filter((r) => r.startsWith("shop/") || r.startsWith("overlay/"));
    expect(pub.sort()).toEqual(Object.keys(PUBLIC_ROUTES).sort());
  });
});
