"use client";

import Link from "next/link";
import { GlobalSearch, NotificationBell } from "../admin-ui/GnbTools";
import { ConfirmProvider, useConfirm } from "../admin-ui/ConfirmDialog";
import { RouteTabs, ShellNavProvider, type ShellNav } from "../admin-ui/shellNav";
import { useWholeDateClick } from "../admin-ui/useWholeDateClick";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLatestResponse, type ReadTicket } from "./latestResponse";
import { api, currentNavGeneration, nextNavGeneration, PLAN_FEATURE_EVENT, type Me, type PlanFeatureEventDetail } from "./api";
import { useEllipsisTitle } from "../admin-ui/useEllipsisTitle";
import { useTableCards } from "../admin-ui/useTableCards";

// 파트너스 관리자 공통 틀(업무용 관리 화면 틀, 대표님 지시 2026-10-04): 상단 고정 GNB(대분류 8개) + 왼쪽 LNB(고른 대분류의 하위 메뉴) + 본문.
// 메뉴 구조는 확정안(2026-10-06 대표님 「그대로 진행」, docs/IA.md 「확정 메뉴 구조」·design/project/SA-LNB.dc.html)을 따른다. 좁은 화면에서는 GNB가 햄버거로 접히고 LNB가 서랍으로 열린다(서랍에는 전체 메뉴).
// 아직 만들지 않은 화면은 메뉴에서 흐리게 두고 누를 수 없게 한다.
// 통합 화면(같은 일을 하는 화면을 한 메뉴로 합친 것)은 항목 하나에 tabs로 기존 화면들을 묶는다. 기존 주소가 그대로 탭 주소라 링크·북마크가 끊기지 않는다.

// perm: 그 권한이 있어야 메뉴가 보인다. OWNER는 대표자 전용.
// plan: 요금제가 그 기능 권한을 줘야 메뉴가 보인다(ARCHITECTURE 4.8.0 판매자 API 분류와 같은 기준). 없으면 구독·결제처럼 항상 열린다.
//   ANY = 기능 권한이 하나라도 있을 때(홈·직원 계정·내 계정: 통합 첫 결제 확정 전에는 닫힘)
//   FOLLOWUP = STORE_OPERATIONS가 있거나, 오버레이 전용으로 내린 뒤에도 후속 처리할 일이 남았을 때(/me orderFollowup). 주문·배송·문의 메뉴(ORDER_FOLLOWUP 경로)
// alt: plan이 없을 때 대신 여는 화면(그 요금제에서 쓸 수 있는 하위 화면만 보여 줄 때)
// tabs: 통합 화면. 탭마다 perm·plan을 따로 가진다(보이는 탭이 하나도 없으면 메뉴 항목도 숨긴다). 보이는 탭이 2개 이상일 때만 탭 줄을 그린다.
// also: 메뉴에는 없지만 이 항목을 켠 채 열리는 화면 주소(예: 시작하기). plan·perm을 따로 줄 수 있다(없으면 항목 것)
// 하위 메뉴가 모두 숨겨진 대분류는 GNB에서도 숨긴다.
type PlanNeed = "ANY" | "OVERLAY" | "EXTERNAL_INTEGRATION" | "STORE_OPERATIONS" | "FOLLOWUP";
type Leaf = { label: string; href?: string; perm?: string; plan?: PlanNeed; alt?: { plan: PlanNeed; href: string } };
type Item = Leaf & { tabs?: Leaf[]; also?: { href: string; plan?: PlanNeed; perm?: string }[]; hidden?: boolean };
// util: 상단 유틸(공지 · 문의·도우미)로 여는 화면의 묶음. GNB에는 올리지 않고 그 화면에서만 자기 LNB로 보인다(SA-LNB ⑤)
type Group = { key: string; label: string; items: Item[]; util?: boolean };
const MENU: Group[] = [
  {
    key: "home",
    label: "홈",
    // 시작하기(SA-003)는 메뉴에서 빠지고 홈 아래 화면이다(첫 가입 때만 홈 위 띠로 안내)
    items: [{ label: "홈", plan: "STORE_OPERATIONS", alt: { plan: "OVERLAY", href: "/seller/home-overlay" }, also: [{ href: "/seller/onboarding", plan: "ANY" }] }],
  },
  {
    key: "broadcast",
    label: "방송",
    items: [
      { label: "방송 대시보드", href: "/seller/broadcast", perm: "BROADCAST_RUN", plan: "OVERLAY" },
      {
        label: "방송 화면 꾸미기",
        tabs: [
          { label: "편집기", href: "/seller/overlay", perm: "OVERLAY_EDIT", plan: "OVERLAY" },
          { label: "방송 프로그램에 넣기", href: "/seller/overlay/address", perm: "OVERLAY_EDIT", plan: "OVERLAY" },
        ],
      },
      {
        label: "방송 기록",
        tabs: [
          { label: "방송별", href: "/seller/broadcasts", perm: "BROADCAST_RUN", plan: "OVERLAY" },
          { label: "HIT 카드", href: "/seller/hit-cards", perm: "BROADCAST_RUN", plan: "OVERLAY" },
        ],
      },
      {
        label: "외부 채널 연결",
        tabs: [
          { label: "유튜브", href: "/seller/youtube", perm: "BROADCAST_RUN", plan: "OVERLAY" },
          // 서버는 플랜 기능 EXTERNAL_INTEGRATION만 보고 보기를 열지만, 메뉴는 연결·해제 권한(SHOP_SETTINGS)이 있는 직원에게만 보인다(서버보다 넓게 열지 않는다)
          { label: "외부 쇼핑몰", href: "/seller/external-shops", perm: "SHOP_SETTINGS", plan: "EXTERNAL_INTEGRATION" },
          // 대표자 전용: 구매(110,000원)·재설치(33,000원)가 걸린 화면이라 서버도 대표자만 허용한다
          { label: "자동 연결", href: "/seller/automation", perm: "OWNER", plan: "OVERLAY" },
        ],
      },
    ],
  },
  {
    key: "order",
    label: "주문",
    items: [
      { label: "전체 주문", href: "/seller/orders", perm: "ORDER_SHIPPING", plan: "FOLLOWUP" },
      { label: "입금 확인", href: "/seller/orders/deposits", perm: "ORDER_SHIPPING", plan: "FOLLOWUP" },
      // 송장 발급·출력·추적 화면이 생기면 이 항목의 탭으로 더한다
      { label: "배송 · 송장", href: "/seller/shipping", perm: "ORDER_SHIPPING", plan: "FOLLOWUP" },
      {
        label: "취소 · 교환 · 반품",
        tabs: [
          // 환불 요청: 상세가 아니라 처리 대기 목록(SA-023-R)
          { label: "취소 · 환불", href: "/seller/orders/refund-requests", perm: "ORDER_SHIPPING", plan: "FOLLOWUP" },
          { label: "교환 · 반품", href: "/seller/returns", perm: "ORDER_SHIPPING", plan: "FOLLOWUP" },
        ],
      },
      { label: "영수증 · 세금계산서", perm: "RECEIPT_TAX", plan: "FOLLOWUP" },
    ],
  },
  {
    key: "product",
    label: "상품",
    items: [
      { label: "상품 목록", href: "/seller/products", perm: "PRODUCT_MANAGE", plan: "STORE_OPERATIONS" },
      { label: "상품 등록", href: "/seller/products/new", perm: "PRODUCT_MANAGE", plan: "STORE_OPERATIONS" },
      {
        label: "재고",
        tabs: [
          { label: "재고 수정", href: "/seller/products/stock", perm: "PRODUCT_MANAGE", plan: "STORE_OPERATIONS" },
          { label: "재입고 알림", href: "/seller/products/restock-alerts", perm: "PRODUCT_MANAGE", plan: "STORE_OPERATIONS" },
        ],
      },
      {
        label: "분류 · 진열",
        tabs: [
          { label: "카테고리", href: "/seller/products/categories", perm: "PRODUCT_MANAGE", plan: "STORE_OPERATIONS" },
          { label: "홈 진열", href: "/seller/products/display", perm: "PRODUCT_MANAGE", plan: "STORE_OPERATIONS" },
        ],
      },
      { label: "엑셀로 올리기 · 내려받기", perm: "PRODUCT_MANAGE", plan: "STORE_OPERATIONS" },
    ],
  },
  {
    key: "member",
    // 고객 = 회원 + 적립금 + 문의·리뷰(게시판 그룹 폐지). 경로(URL)는 그대로
    label: "고객",
    items: [
      { label: "회원 목록", href: "/seller/members", perm: "MEMBER_POINTS", plan: "STORE_OPERATIONS" },
      { label: "회원 등급", href: "/seller/member-grades", perm: "MEMBER_POINTS", plan: "STORE_OPERATIONS" },
      { label: "구매 제한", href: "/seller/purchase-restrictions", perm: "MEMBER_POINTS", plan: "FOLLOWUP" },
      { label: "회원에게 알림 보내기", href: "/seller/member-messages", perm: "MEMBER_POINTS", plan: "STORE_OPERATIONS" },
      {
        label: "적립금",
        tabs: [
          { label: "적립 정책", href: "/seller/rewards", perm: "MEMBER_POINTS", plan: "STORE_OPERATIONS" },
          // 원장 API(GET /api/seller/reward-ledger)가 ORDER_FOLLOWUP 경로라 오버레이 전용으로 내린 뒤에도 후속 확인할 수 있다
          { label: "지급 · 회수 원장", href: "/seller/rewards/ledger", perm: "MEMBER_POINTS", plan: "FOLLOWUP" },
          { label: "회원별 잔액", href: "/seller/rewards/balances", perm: "MEMBER_POINTS", plan: "STORE_OPERATIONS" },
          // 보기는 MEMBER_POINTS, 켜고 끄기는 대표자만(화면·서버가 막는다)
          { label: "실제 지급 켜기", href: "/seller/rewards/live-payout", perm: "MEMBER_POINTS", plan: "STORE_OPERATIONS" },
        ],
      },
      {
        label: "문의 · 리뷰",
        tabs: [
          { label: "문의", href: "/seller/buyer-inquiries", perm: "INQUIRY_REPLY", plan: "FOLLOWUP" },
          // 상품 리뷰: 목록·집계 조회는 파트너스 계정 누구나, 답글·숨김·설정은 구매자 문의(INQUIRY_REPLY) 권한(서버에서 막음). 서버가 스토어 운영 기능을 요구한다
          { label: "리뷰", href: "/seller/reviews", plan: "STORE_OPERATIONS" },
        ],
      },
    ],
  },
  {
    key: "marketing",
    // 마케팅 = 쿠폰(프로모션) + 홈 배너·이벤트 팝업(디자인) + 쇼핑몰 공지·FAQ
    label: "마케팅",
    items: [
      // 쿠폰: 집계 조회는 파트너스 계정 누구나, 만들기·지급은 적립금(MEMBER_POINTS) 권한(화면에서 막음)
      { label: "쿠폰", href: "/seller/coupons", plan: "STORE_OPERATIONS" },
      { label: "홈 배너", href: "/seller/banners", plan: "STORE_OPERATIONS" },
      { label: "이벤트 팝업", href: "/seller/banners/popups", plan: "STORE_OPERATIONS" },
      // 보기는 권한 없이, 쓰기는 화면에서 SHOP_SETTINGS로 막는다
      { label: "쇼핑몰 공지 · 자주 묻는 질문", href: "/seller/settings/shop-notices", plan: "STORE_OPERATIONS" },
    ],
  },
  {
    key: "stats",
    label: "통계",
    // 오버레이 전용은 방송 통계만(매출·상품 등은 스토어 운영, MASTER 결정 2026-10-04)
    items: [{ label: "통계", href: "/seller/stats", perm: "SALES_VIEW", plan: "STORE_OPERATIONS", alt: { plan: "OVERLAY", href: "/seller/stats/broadcasts" } }],
  },
  {
    key: "settings",
    label: "설정",
    items: [
      // 공유 설정(파비콘·공유 카드)은 쇼핑몰 정보 안에 들어간다
      { label: "쇼핑몰 정보", href: "/seller/settings/shop", plan: "STORE_OPERATIONS", also: [{ href: "/seller/settings/share" }] },
      {
        label: "주문 · 배송 설정",
        tabs: [
          { label: "주문 설정", href: "/seller/settings/order", perm: "SHOP_SETTINGS", plan: "STORE_OPERATIONS" },
          { label: "배송 설정", href: "/seller/settings/shipping", perm: "SHOP_SETTINGS", plan: "STORE_OPERATIONS" },
        ],
      },
      {
        label: "약관 · 회원 정책",
        tabs: [
          { label: "약관", href: "/seller/settings/legal", perm: "SHOP_SETTINGS", plan: "STORE_OPERATIONS" },
          { label: "회원 정책", href: "/seller/settings/member", perm: "MEMBER_POINTS", plan: "STORE_OPERATIONS" },
        ],
      },
      { label: "검색 노출", href: "/seller/settings/seo", perm: "SHOP_SETTINGS", plan: "STORE_OPERATIONS" },
      // 화면이 쓰는 GET /api/seller/message-balance가 대표자 전용이라 메뉴도 대표자에게만 보인다(서버보다 넓게 열지 않는다)
      { label: "알림 설정", href: "/seller/settings/order-notifications", perm: "OWNER", plan: "STORE_OPERATIONS" },
      { label: "충전금", href: "/seller/settings/message-balance", perm: "OWNER", plan: "ANY" },
      { label: "직원 계정", href: "/seller/staff", perm: "OWNER", plan: "ANY" },
      { label: "구독 · 결제", href: "/seller/subscription", perm: "OWNER" },
      { label: "쇼핑몰 통합 전환", perm: "OWNER" },
    ],
  },
  {
    key: "notice",
    label: "공지 · 문의",
    util: true,
    items: [
      { label: "공지사항", href: "/seller/notices" },
      { label: "내 문의", href: "/seller/inquiries" },
      // 알림 센터(SA-130)는 메뉴에 없는 화면: 경로 줄만 「공지 · 문의 › 알림」
      { label: "알림", href: "/seller/notifications", hidden: true },
    ],
  },
  { key: "assistant", label: "도우미", util: true, items: [{ label: "도우미", href: "/seller/assistant" }] },
];

// 항목의 화면들(탭이 없으면 항목 자신 하나)
function leavesOf(item: Item): Leaf[] {
  return item.tabs ?? [item];
}

// 주소로 바로 들어와도 요금제에 없는 화면은 안내 화면을 보인다. 메뉴 묶음과 다른 하위 화면만 따로 적는다(긴 주소가 먼저)
const ROUTE_PLAN: [string, PlanNeed][] = [["/seller/stats/broadcasts", "OVERLAY"]];
// 쇼핑몰 설정 하위 화면(/seller/settings/…)은 메뉴마다 따로 주소가 있어 접두어가 길게 맞는 메뉴를 고른다
function routeNav(pathname: string): { group: Group; item: Item; leaf: Leaf; exactHref: boolean } | null {
  let best: { group: Group; item: Item; leaf: Leaf; len: number } | null = null;
  for (const group of MENU)
    for (const item of group.items) {
      const cands: { href?: string; leaf: Leaf }[] = [
        ...leavesOf(item).map((leaf) => ({ href: leaf.href, leaf })),
        // 메뉴에 없는 딸린 화면: plan·perm은 따로 있으면 그것, 없으면 항목 것(탭 항목이면 첫 탭 것)
        ...(item.also ?? []).map((a) => ({ href: a.href, leaf: { ...leavesOf(item)[0], href: a.href, plan: a.plan ?? leavesOf(item)[0].plan, perm: a.perm ?? leavesOf(item)[0].perm } })),
      ];
      for (const { href, leaf } of cands) {
        if (href && (pathname === href || pathname.startsWith(`${href}/`)) && (!best || href.length > best.len)) best = { group, item, leaf, len: href.length };
      }
    }
  if (!best) return null;
  return { group: best.group, item: best.item, leaf: best.leaf, exactHref: leavesOf(best.item).some((l) => l.href === pathname) };
}
// 상단 바 경로(「주문 › 전체 주문」처럼 대분류 › 메뉴)
function routeCrumb(pathname: string): string {
  const r = routeNav(pathname);
  if (!r) return "파트너스";
  return r.group.label !== r.item.label ? `${r.group.label} › ${r.item.label}` : r.item.label;
}
// FOLLOWUP은 메뉴를 숨길 때만 쓴다. 주소로 들어온 화면은 서버(ORDER_FOLLOWUP 경로는 기능 권한이 하나라도 있으면 열림)가 막는지에 따른다
function routePlan(pathname: string): PlanNeed | undefined {
  const r = routeNav(pathname);
  const need = ROUTE_PLAN.find(([p]) => pathname.startsWith(p))?.[1] ?? r?.leaf.plan;
  return need === "FOLLOWUP" ? "ANY" : need;
}

// 요금제 기능 권한만 보는 판단(통계 탭 등). FOLLOWUP은 후속 처리 여부(orderFollowup)가 필요해 menuAllows가 본다
export function planAllows(features: readonly string[] | undefined, need?: Exclude<PlanNeed, "FOLLOWUP">): boolean {
  const f = features ?? [];
  return !need || (need === "ANY" ? f.length > 0 : f.includes(need));
}
function menuAllows(me: Pick<Me, "features" | "orderFollowup">, need?: PlanNeed): boolean {
  return need === "FOLLOWUP" ? planAllows(me.features, "STORE_OPERATIONS") || !!me.orderFollowup : planAllows(me.features, need);
}
function canFor(me: Me, perm: string) {
  return me.isOwner || (perm !== "OWNER" && me.permissions.includes(perm));
}
// 보이는 메뉴 항목: href는 보이는 첫 화면, tabs는 보이는 화면들(없으면 단일 화면)
type ShownItem = Item & { shownTabs: Leaf[] };
type ShownGroup = { key: string; label: string; items: ShownItem[]; util?: boolean };
// 권한·요금제 기능이 없는 메뉴는 숨기고(alt가 열리면 그 화면으로), 안에 메뉴가 하나도 안 남은 대분류도 숨긴다
function visibleMenu(me: Me): ShownGroup[] {
  return MENU.map((g) => ({
    ...g,
    items: g.items.flatMap((n): ShownItem[] => {
      const leaves = leavesOf(n).flatMap((l): Leaf[] => {
        if (l.perm && !canFor(me, l.perm)) return [];
        if (menuAllows(me, l.plan)) return [l];
        return l.alt && menuAllows(me, l.alt.plan) ? [{ ...l, href: l.alt.href }] : [];
      });
      if (leaves.length === 0) return [];
      return [{ ...n, href: leaves[0].href, shownTabs: n.tabs ? leaves : [] }];
    }),
  })).filter((g) => g.items.length > 0);
}
// 로그인 뒤 갈 화면: 기본 화면(href)이 요금제·권한에 없으면 만든 메뉴 중 지금 열리는 첫 메뉴.
// 열 수 있는 메뉴가 하나도 없으면 기본 화면 그대로(UX-06)
export function landingFor(me: Me, href: string): string {
  const perm = routeNav(href)?.leaf.perm;
  if (menuAllows(me, routePlan(href)) && (!perm || canFor(me, perm))) return href;
  return visibleMenu(me).flatMap((g) => g.items).find((n) => !!n.href)?.href ?? href;
}

// loc: 지금 화면의 대분류 · 메뉴 이름(본문 위 경로 줄에 쓴다)
// groupHref·itemHref: 경로 줄에서 앞 항목을 눌러 갈 주소(대분류의 첫 화면·메뉴 항목의 첫 화면)
type ShellCtx = {
  me: Me;
  trialDaysLeft: number | null;
  openNav: () => void;
  can: (perm: string) => boolean;
  loc: { group: string; item: string; exact: boolean; groupHref?: string; itemHref?: string } | null;
};
const Ctx = createContext<ShellCtx | null>(null);

export function useSeller(): ShellCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("SellerShell 안에서만 써요");
  return v;
}

export function SellerShell({ children }: { children: React.ReactNode }) {
  useEllipsisTitle();
  useTableCards();
  // 날짜 칸 어디를 눌러도 달력이 열린다(화면마다 따로 걸지 않는다)
  useWholeDateClick();
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const [trialDaysLeft, setTrialDaysLeft] = useState<number | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const drawerEntry = useRef(false);
  // GNB에서 고른 대분류(화면을 옮기면 지금 화면의 대분류로 돌아간다)
  const [picked, setPicked] = useState<string | null>(null);

  const lastRead = useRef(0);
  // /me 다시 읽기 반영 규칙(latestResponse.ts): 나중에 보낸 요청의 성공만 반영하고, 실패가 앞선 성공을 버리지 않는다.
  // 반영할 때 파생 값(남은 체험 일수)도 함께 계산한다: 처음 읽기·다시 읽기 어느 쪽이 먼저 성공해도 같은 결과
  const meReads = useLatestResponse();
  // 반영한 /me의 세대(요금제 차단 뒤 다시 읽은 값인지 가리는 데 쓴다)
  const [meGen, setMeGen] = useState(0);
  const applyMe = (t: ReadTicket, data: Me) => {
    if (meReads.accept(t) !== "apply") return;
    setFailed(false);
    setMe(data);
    setMeGen(t.n);
    // 체험 중이면 /me가 끝나는 시각을 준다(대표자·직원 모두)
    setTrialDaysLeft(data.access === "trial" && data.trialEndsAt ? Math.max(0, Math.ceil((new Date(data.trialEndsAt).getTime() - Date.now()) / 86_400_000)) : null);
  };
  const load = useCallback(async () => {
    lastRead.current = Date.now();
    setFailed(false);
    const t = meReads.next();
    const r = await api<Me>("/api/seller/me");
    if (!r.ok) {
      if (r.status === 401) router.replace(`/seller/login?next=${encodeURIComponent(pathname)}`);
      // 아직 한 번도 그리지 못했으면 다시 시도 화면을 보인다(이미 그린 화면은 그대로 둔다)
      else if (!meReads.hasApplied() && meReads.failMatters(t)) setFailed(true);
      return;
    }
    applyMe(t, r.data);
  }, [router, pathname]);

  useEffect(() => {
    void load();
    // 처음 한 번 불러온다
  }, []);

  // 화면을 옮길 때마다 권한·이용 상태를 조용히 다시 읽는다(대표자가 직원 권한을 바꾸면 다음 화면부터 메뉴에 반영).
  // 로딩 화면은 띄우지 않고, 실패하면 지금 값을 그대로 둔다(401이면 공통 api()가 로그인으로 보낸다)
  // 창으로 돌아올 때(포커스·화면이 다시 보일 때)도 다시 읽는다: 권한이 하나도 없는 직원은 옮길 화면이 없어 경로로는 새로 읽지 못한다.
  // 짧은 간격으로 겹치면(포커스와 visibilitychange가 함께 오는 경우 등) 한 번만 읽는다
  const refresh = useCallback((): number => {
    lastRead.current = Date.now();
    const t = meReads.next();
    void api<Me>("/api/seller/me").then((r) => {
      if (r.ok) applyMe(t, r.data);
    });
    return t.n;
  }, []);
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = pathname;
    refresh();
  }, [pathname, refresh]);
  useEffect(() => {
    // 마지막으로 읽은 지 1초 안에 돌아오면 바로 읽지 않고 1초가 되는 때로 한 번 미룬다(버리면 그사이 바뀐 권한을 다음 포커스까지 못 본다)
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const onBack = () => {
      if (document.visibilityState !== "visible") return;
      const wait = 1000 - (Date.now() - lastRead.current);
      if (wait <= 0) return refresh();
      if (trailing) return;
      trailing = setTimeout(() => {
        trailing = null;
        refresh();
      }, wait);
    };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      if (trailing) clearTimeout(trailing);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [refresh]);

  useEffect(() => {
    drawerEntry.current = false;
    setNavOpen(false);
    setPicked(null);
  }, [pathname]);

  // 서랍(1024 미만)을 열 때만 기록 한 칸을 얹어, Back을 누르면 페이지를 떠나지 않고 서랍부터 닫는다(전역 popstate 가로채기 없음).
  // 링크로 이동할 때는 기록을 되돌리지 않는다(이동과 겹치지 않게).
  const openNav = () => {
    if (!drawerEntry.current) {
      window.history.pushState(null, "", window.location.href);
      drawerEntry.current = true;
    }
    setNavOpen(true);
  };
  const closeNav = () => {
    setNavOpen(false);
    if (drawerEntry.current) {
      drawerEntry.current = false;
      window.history.back();
    }
  };
  const leaveNav = () => {
    drawerEntry.current = false;
    setNavOpen(false);
  };
  useEffect(() => {
    if (!navOpen) return;
    const onPop = () => {
      if (!drawerEntry.current) return;
      drawerEntry.current = false;
      setNavOpen(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [navOpen]);

  // 화면 방문 번호: 경로가 바뀌면 화면(자식)을 그리기 전에 올린다. 자식의 첫 요청도 새 번호를 갖도록 렌더 중에 한 번만 올린다
  const visitPath = useRef<string | null>(null);
  if (visitPath.current !== pathname) {
    visitPath.current = pathname;
    nextNavGeneration();
  }
  // 화면이 부른 API가 403 plan_feature_required면(그사이 요금제가 바뀐 경우 등) 그 화면을 안내 화면으로 바꾸고 메뉴를 다시 읽는다.
  // 요청을 보낸 방문과 지금 방문이 다르면(옮긴 뒤 늦게 온 응답, 같은 경로로 돌아온 경우 포함) 무시한다. 차단은 화면을 떠나면 지우고,
  // 차단 뒤 다시 읽은 /me(gen 이후 세대)가 이 화면을 허용하면 지운다(그사이 요금제를 올린 경우)
  const [planBlocked, setPlanBlocked] = useState<{ path: string; visit: number; gen: number } | null>(null);
  useEffect(() => {
    const onBlocked = (e: Event) => {
      const visit = (e as CustomEvent<PlanFeatureEventDetail>).detail?.visit;
      if (visit !== currentNavGeneration()) return;
      setPlanBlocked({ path: window.location.pathname, visit, gen: refresh() });
    };
    window.addEventListener(PLAN_FEATURE_EVENT, onBlocked);
    return () => window.removeEventListener(PLAN_FEATURE_EVENT, onBlocked);
  }, [refresh]);
  useEffect(() => setPlanBlocked(null), [pathname]);
  // 화면의 요금제 조건을 모르면(routePlan 없음) 허용을 확인할 수 없어 떠날 때까지 둔다(다시 막히는 되풀이 방지)
  useEffect(() => {
    const need = planBlocked && routePlan(planBlocked.path);
    if (planBlocked && need && me && meGen >= planBlocked.gen && menuAllows(me, need)) setPlanBlocked(null);
  }, [planBlocked, me, meGen]);

  // 세션을 실제로 끊었을 때만 로그인 화면으로 보낸다. 실패하면 화면에 남아 다시 시도하게 한다(공용 기기에서 로그아웃된 줄 착각하지 않게).
  const [logoutError, setLogoutError] = useState(false);
  const logout = async () => {
    setLogoutError(false);
    const r = await api("/api/seller/auth/logout", { method: "POST" });
    if (r.ok) router.replace("/seller/login");
    else setLogoutError(true);
  };

  if (failed) {
    return (
      <div className="st" style={{ minHeight: "100vh", borderRadius: 0 }}>
        <div className="st-ic neg">!</div>
        <span className="t">화면을 불러오지 못했습니다</span>
        <button className="btn btn-sm" type="button" onClick={() => void load()}>
          다시 시도
        </button>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="st" style={{ minHeight: "100vh", borderRadius: 0 }} aria-busy="true">
        <span className="spin" />
      </div>
    );
  }

  const can = (perm: string) => canFor(me, perm);
  const features = me.features ?? [];
  const menu = visibleMenu(me);
  const gnbMenu = menu.filter((g) => !g.util);
  const route = routeNav(pathname);
  const active = route && menu.some((g) => g.key === route.group.key) ? route : null;
  const shown = menu.find((g) => g.key === picked) ?? menu.find((g) => g.key === active?.group.key) ?? gnbMenu[0];
  const shownGroup = active ? menu.find((g) => g.key === active.group.key) : undefined;
  const shownItem = shownGroup?.items.find((n) => n.label === active?.item.label);
  const loc =
    active && shownGroup && shownItem
      ? { group: active.group.label, item: active.item.label, exact: active.exactHref, groupHref: shownGroup.items.find((n) => n.href)?.href, itemHref: shownItem.href }
      : null;
  // 화면 ←·통합 화면 탭(PageHead가 읽는다): ←는 메뉴로 바로 여는 화면이 아닐 때만, 부모는 그 화면이 속한 메뉴 화면
  const shellNav: ShellNav = {
    backHref: active && !active.exactHref ? (shownItem?.shownTabs.find((t) => t.href && pathname.startsWith(`${t.href}/`))?.href ?? shownItem?.href ?? null) : null,
    tabs: shownItem && shownItem.shownTabs.length >= 2 ? shownItem.shownTabs.map((t) => ({ label: t.label, href: t.href ?? "", on: t.href === active?.leaf.href })) : [],
  };
  const blocked = (planBlocked?.path === pathname && planBlocked.visit === currentNavGeneration()) || !menuAllows(me, routePlan(pathname));
  // 안내 화면에서 갈 수 있는 첫 화면(만든 메뉴 중 지금 열리는 것)
  const nextNav = gnbMenu.flatMap((g) => g.items).find((n) => !!n.href && !pathname.startsWith(n.href));

  const utilities = (
    <>
      <a className="util-i" href={`/shop/${me.shop.slug}`} target="_blank" rel="noreferrer">
        쇼핑몰 보기
      </a>
      <Link className="util-i" href="/seller/notices" onClick={leaveNav}>
        공지 · 문의
      </Link>
      <Link className="util-i" href="/seller/assistant" onClick={leaveNav}>
        도우미
      </Link>
      <Link className="util-i" href="/seller/account" onClick={leaveNav}>
        내 계정
      </Link>
      <button className="util-i util-btn" type="button" onClick={() => void logout()}>
        로그아웃
      </button>
    </>
  );

  return (
    <Ctx.Provider value={{ me, trialDaysLeft, openNav, can, loc }}>
      <ShellNavProvider value={shellNav}>
      <ConfirmProvider readOnly={!!me.readOnly}>
      <div className={`cs${navOpen ? " nav-open" : ""}${me.impersonation ? " imp" : ""}`} data-readonly={me.readOnly ? "true" : undefined}>
        <header className="gnb">
          <button className="gnb-menu" type="button" aria-label="메뉴 열기" onClick={openNav}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <Link className="logo gnb-logo" href="/seller/products">
            <span className="logo-sym" />
            <span className="logo-word" />
            <span className="gnb-sub">파트너스</span>
          </Link>
          <nav className="gnb-nav" aria-label="주 메뉴">
            {gnbMenu.map((g) => {
              const first = g.items.find((n) => n.href)?.href;
              const cls = `gnb-i${g.key === shown.key ? " on" : ""}`;
              return first ? (
                <Link key={g.key} className={cls} href={first} onClick={() => setPicked(null)}>
                  {g.label}
                </Link>
              ) : (
                <button key={g.key} className={cls} type="button" aria-pressed={g.key === shown.key} onClick={() => setPicked(g.key)}>
                  {g.label}
                </button>
              );
            })}
          </nav>
          <div className="gnb-util">
            <span className="gnb-shop ell" title={`${me.user.name} · ${me.user.email}`}>
              {me.shop.name}
            </span>
            <GlobalSearch scope="seller" />
            <NotificationBell scope="seller" allHref="/seller/notifications" />
            <span className="util-desk">{utilities}</span>
          </div>
        </header>
        {me.impersonation && <ImpersonationBar shop={me.shop.name} imp={me.impersonation} />}
        {logoutError && (
          <div className="msg msg-neg logout-err" role="alert">
            로그아웃하지 못했습니다. 다시 시도해 주십시오
          </div>
        )}
        <div className="cs-wrap">
          <aside className="lnb" aria-label="파트너스 메뉴">
            {menu.map((g) => (
              <section key={g.key} className={`lnb-sec${g.key === shown.key ? " on" : ""}`}>
                <strong className="lnb-h">{g.label}</strong>
                {g.items.filter((n) => !n.hidden).map((n) =>
                  n.href ? (
                    <Link
                      key={n.label}
                      className={`lnb-i${active?.item.label === n.label ? " on" : ""}`}
                      href={n.href}
                      aria-current={active?.item.label === n.label ? "page" : undefined}
                      onClick={leaveNav}
                    >
                      {n.label}
                    </Link>
                  ) : (
                    <a key={n.label} className="lnb-i off" aria-disabled="true" title="준비 중입니다">
                      {n.label}
                    </a>
                  ),
                )}
              </section>
            ))}
            <div className="lnb-util">{utilities}</div>
          </aside>
          <button className="cs-dim" type="button" aria-label="메뉴 닫기" onClick={closeNav} />
          <div className="col cs-body">
            {blocked ? <PlanFeatureRequired crumb={routeCrumb(pathname)} noFeatures={features.length === 0} next={nextNav} /> : children}
          </div>
        </div>
      </div>
      </ConfirmProvider>
      </ShellNavProvider>
    </Ctx.Provider>
  );
}

// 지금 요금제에 없는 기능(서버 403 plan_feature_required, 또는 /me features에 없음)의 안내 화면
function PlanFeatureRequired({ crumb, noFeatures, next }: { crumb: string; noFeatures: boolean; next?: { label: string; href?: string } }) {
  const { me } = useSeller();
  return (
    <>
      <Topbar crumb={crumb} />
      <main className="main">
        <div className="card st" style={{ boxShadow: "none" }} data-testid="plan-feature-required">
          <div className="st-ic lock">!</div>
          <h1 className="t">지금 요금제에서 사용할 수 없는 기능입니다</h1>
          <span className="s">{noFeatures ? "구독료 첫 결제가 확정되면 사용할 수 있습니다" : "쇼핑몰 통합 요금제에서 사용할 수 있습니다"}</span>
          <span className="s">
            {me.isOwner ? (
              <>
                요금제는 <Link href="/seller/subscription">구독 · 결제</Link>에서 바꿀 수 있습니다
              </>
            ) : (
              "요금제 변경은 대표자에게 요청해 주십시오"
            )}
          </span>
          {next?.href && (
            <Link className="btn btn-sm" href={next.href}>
              {next.label} 화면으로 이동
            </Link>
          )}
        </div>
      </main>
    </>
  );
}

// 화면마다 본문 위에 경로 줄(대분류 › 메뉴 · 오른쪽 버튼)을 넣고, 그 아래에 이용 상태 배너를 붙인다.
// crumb: 예전 경로 문구. 경로는 메뉴 구조에서 만들고, 하위 화면(주문 상세·이벤트 팝업 등)이면 crumb 마지막 칸을 덧붙인다.
export function Topbar({ crumb, badge, children }: { crumb: string; badge?: React.ReactNode; children?: React.ReactNode }) {
  const { loc } = useSeller();
  const parts = crumb.split("›").map((p) => p.trim());
  const last = parts[parts.length - 1];
  // 경로 줄: 「대분류 › 메뉴 › 현재 화면」. 앞 항목은 눌러서 갈 수 있다(메뉴 구조에서 만든 경로만 링크)
  const raw = loc
    ? [
        { t: loc.group, href: loc.groupHref },
        { t: loc.item, href: loc.itemHref },
      ]
    : parts.map((t) => ({ t, href: undefined as string | undefined }));
  if (loc && !loc.exact && parts.length > 2 && last !== loc.item && last !== loc.group) raw.push({ t: last, href: undefined });
  // 대분류와 메뉴 이름이 같으면(통계 › 통계) 한 번만
  const shownPath = raw.filter((p, i) => i === 0 || p.t !== raw[i - 1].t);
  return (
    <>
      <div className="loc-bar">
        <span className="crumb ell">
          {shownPath.map((p, i) => (
            <span key={i} className={i === shownPath.length - 1 ? "crumb-now" : undefined}>
              {i > 0 && <span className="crumb-sep" aria-hidden="true">›</span>}
              {p.href && i < shownPath.length - 1 ? (
                <Link className="crumb-link" href={p.href}>
                  {p.t}
                </Link>
              ) : (
                p.t
              )}
            </span>
          ))}
        </span>
        {badge}
        <div className="row tb-actions">{children}</div>
      </div>
      <AccessBanner />
      <RouteTabs className="rtabs-top" />
    </>
  );
}

// 마스터 대리 조회 배너(MA-016 정본): GNB 아래 고정, 쇼핑몰·운영자·사유·남은 시간·종료. 종료는 관리자 세션으로 끝내고 파트너스 목록으로 돌아간다.
// 끝나는 시각이 지나면 /me를 다시 읽어 세션 만료(401)를 로그인 화면으로 처리한다.
function ImpersonationBar({ shop, imp }: { shop: string; imp: NonNullable<Me["impersonation"]> }) {
  const [now, setNow] = useState(() => Date.now());
  const [ending, setEnding] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((new Date(imp.expiresAt).getTime() - now) / 1000));
  const { confirm } = useConfirm();
  // 대리 조회 끝내기: 서버에 쓰는 행동이라 확인 창을 거친다(읽기 전용 중에도 되는 행동이라 allowReadOnly)
  const end = async () => {
    setEnding(true);
    const ok = await confirm({
      title: "대신 보기를 끝내시겠습니까?",
      body: "읽기 전용 화면이 닫히고 마스터 관리자로 돌아갑니다.",
      confirmLabel: "끝내기",
      allowReadOnly: true,
      run: async () => ((await api("/api/admin/impersonation", { method: "DELETE" })).ok ? undefined : "끝내지 못했습니다. 잠시 후 다시 시도해 주십시오"),
    });
    if (ok) window.location.assign("/admin/partners");
    else setEnding(false);
  };
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <div className="imp-bar" role="status">
      <b>읽기 전용 · 대신 보기</b>
      <span className="imp-txt ell">
        「{shop}」 화면을 보는 중 · 운영 {imp.adminName} · 사유 {imp.reason}
      </span>
      <span className="imp-left">{left === 0 ? "시간이 끝났습니다" : `남은 시간 ${mm}:${ss}`}</span>
      <button className="btn btn-sm imp-end" type="button" disabled={ending} onClick={() => void end()}>
        종료
      </button>
    </div>
  );
}

function AccessBanner() {
  const { me, trialDaysLeft } = useSeller();
  if (me.access === "trial") {
    return (
      <div className="msg msg-info access-banner" role="status">
        <b>{trialDaysLeft === null ? "체험 중입니다" : trialDaysLeft === 0 ? "체험이 오늘 끝납니다" : `체험이 ${trialDaysLeft}일 남았습니다`}</b>
        <span>체험이 끝나기 전에 구독하면 그대로 이어서 사용할 수 있습니다</span>
      </div>
    );
  }
  if (me.access === "grace") {
    return (
      <div className="msg msg-cau access-banner" role="status">
        <b>구독료 결제가 되지 않았습니다</b>
        <span>결제 카드를 확인해 주십시오. 며칠 안에 결제되지 않으면 새 판매가 중지됩니다</span>
      </div>
    );
  }
  if (me.access === "expired") {
    return (
      <div className="msg msg-neg access-banner" role="alert">
        <b>이용 기간이 끝났습니다</b>
        <span>지금은 상품 등록·수정과 새 판매가 중지되어 있습니다. {me.isOwner ? "구독하면 바로 다시 사용할 수 있습니다" : "대표자에게 구독을 요청해 주십시오"}</span>
      </div>
    );
  }
  return null;
}
