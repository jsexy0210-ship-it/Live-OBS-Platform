import { adminCan, type AdminPermission } from "../../../../lib/server/authz/permissions";

// 마스터 관리자 메뉴: 확정 구조(2026-10-06 대표님 「그대로 진행」, docs/IA.md 「확정 메뉴 구조」·design/project/SA-LNB.dc.html·DS-NAV). GNB 6그룹·LNB 24항목.
// perm은 그 화면의 서버 API가 요구하는 권한과 같다(없으면 platform.read).
// ready: 화면이 있는 메뉴. 없으면 「준비 중」 한 줄 화면으로 연결한다. 하위 메뉴가 모두 숨겨진 대분류는 GNB에서도 숨긴다.
// sub: LNB 소제목(회색 12px). 설정 그룹의 「시스템」·「관리자」. 앞 항목과 소제목이 다를 때 한 번 그린다(앞 항목이 역할로 숨겨져도 소제목은 남는다)
export type AdminRole = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
export type AdminItem = { label: string; href: string; perm?: AdminPermission; ready?: true; sub?: string };
export type AdminGroup = { key: string; label: string; items: AdminItem[] };

export const ADMIN_MENU: AdminGroup[] = [
  // 메뉴 이름은 「홈」, 화면 제목은 「통합 대시보드」
  { key: "home", label: "홈", items: [{ label: "홈", href: "/admin" }] },
  {
    key: "partners",
    label: "파트너스",
    items: [
      { label: "파트너스 목록", href: "/admin/partners", ready: true },
      { label: "가입 신청", href: "/admin/partners/applications", ready: true },
      { label: "결제 연결 상태", href: "/admin/settlement/pg", ready: true },
      { label: "적립금 실제 지급 켠 파트너스", href: "/admin/ops/rewards", ready: true },
    ],
  },
  {
    key: "billing",
    label: "요금 · 결제",
    items: [
      { label: "요금제", href: "/admin/billing/plans", ready: true },
      { label: "구독 현황", href: "/admin/billing/subscriptions", ready: true },
      { label: "청구 · 결제 내역", href: "/admin/billing/invoices", ready: true },
      { label: "구독료 수납", href: "/admin/settlement/collection", ready: true },
      { label: "환불 요청", href: "/admin/billing/refunds", ready: true },
    ],
  },
  {
    key: "ops",
    label: "운영",
    items: [
      { label: "실시간 방송", href: "/admin/ops/live", ready: true },
      { label: "주문 · 방송 화면 접속", href: "/admin/ops/access", ready: true },
      { label: "실시간 감시", href: "/admin/ops/monitor", perm: "system.manage", ready: true },
      { label: "자동 연결 작업", href: "/admin/ops/automation", ready: true },
    ],
  },
  {
    key: "support",
    label: "고객지원",
    items: [
      { label: "파트너스 문의", href: "/admin/support/inquiries", ready: true },
      { label: "공지사항", href: "/admin/support/notices", ready: true },
      { label: "도우미 답변 자료", href: "/admin/support/assistant", ready: true },
    ],
  },
  {
    key: "settings",
    label: "설정",
    items: [
      // 설정(MA-080대)은 최고관리자만(MASTER 결정 2026-10-04). 서버 조회 API는 platform.read지만 메뉴·주소는 막는다
      { label: "플랫폼 기본 정책", href: "/admin/settings/policy", perm: "system.manage", sub: "시스템" },
      { label: "알림 채널", href: "/admin/settings/notifications", perm: "system.manage", sub: "시스템" },
      { label: "점검 모드", href: "/admin/settings/maintenance", perm: "system.manage", ready: true, sub: "시스템" },
      { label: "도우미 설정", href: "/admin/settings/assistant", perm: "system.manage", ready: true, sub: "시스템" },
      { label: "파비콘 · 공유 카드", href: "/admin/settings/branding", perm: "system.manage", ready: true, sub: "시스템" },
      { label: "발송 단가", href: "/admin/settings/messages", perm: "system.manage", ready: true, sub: "시스템" },
      { label: "외부 서비스 연동", href: "/admin/settings/vendors", perm: "vendor.manage", ready: true, sub: "시스템" },
      { label: "관리자 계정", href: "/admin/accounts", perm: "admin.manage", ready: true, sub: "관리자" },
      { label: "역할별 권한", href: "/admin/accounts/roles", perm: "admin.manage", ready: true, sub: "관리자" },
      // 로그 추적은 CS에 숨긴다(audit.read)
      { label: "로그 추적", href: "/admin/logs", perm: "audit.read", ready: true, sub: "관리자" },
    ],
  },
];

export const itemAllowed = (role: AdminRole, item: AdminItem) => adminCan(role, item.perm ?? "platform.read");

export function visibleAdminMenu(role: AdminRole): AdminGroup[] {
  return ADMIN_MENU.map((g) => ({ ...g, items: g.items.filter((n) => itemAllowed(role, n)) })).filter((g) => g.items.length > 0);
}

// 지금 주소의 대분류·메뉴(주소가 길게 맞는 메뉴)
export function routeNav(pathname: string): { group: AdminGroup; item: AdminItem } | null {
  let best: { group: AdminGroup; item: AdminItem } | null = null;
  for (const group of ADMIN_MENU)
    for (const item of group.items)
      if ((pathname === item.href || (item.href !== "/admin" && pathname.startsWith(`${item.href}/`))) && (!best || item.href.length > best.item.href.length)) best = { group, item };
  return best;
}
