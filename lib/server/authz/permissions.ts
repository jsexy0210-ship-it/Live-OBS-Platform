import type { PlatformAdminRole, SellerStaffPermission } from "@prisma/client";

// 마스터 역할별 권한 표 (docs/ARCHITECTURE.md 3.2). 권한 판단은 이 표 한 곳에서만 한다.
export const ADMIN_PERMISSIONS = {
  "platform.read": ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"],
  "seller.moderate": ["SUPER_ADMIN", "OPERATIONS"],
  "billing.manage": ["SUPER_ADMIN", "OPERATIONS"],
  // 구독 가격 변경은 최고관리자(대표님)만(MASTER 결정 2026-10-03)
  "billing.price": ["SUPER_ADMIN"],
  // 구독 환불 승인·거절은 최고관리자만(MA-027 FINAL v327). 요청 만들기는 billing.manage
  "billing.refund": ["SUPER_ADMIN"],
  "support.manage": ["SUPER_ADMIN", "CS"],
  // 파트너스 문의 담당 배정·변경(MASTER 결정 2026-10-06: 운영·CS·최고관리자)
  "support.assign": ["SUPER_ADMIN", "OPERATIONS", "CS"],
  "seller.impersonate": ["SUPER_ADMIN", "OPERATIONS", "CS"],
  "admin.manage": ["SUPER_ADMIN"],
  "system.manage": ["SUPER_ADMIN"],
  // 인프라·비용(MA-120): 용량·요금 조회와 단가 입력은 최고관리자만(대표님 지시 2026-10-06)
  "infra.manage": ["SUPER_ADMIN"],
  "audit.read": ["SUPER_ADMIN", "OPERATIONS", "READ_ONLY"],
  // 외부 서비스 업체 등록·비교·추천·선택(설정 > 외부 서비스 연동). 변경은 최고관리자·운영(대표님 지시 2026-10-05), 조회는 platform.read
  "vendor.manage": ["SUPER_ADMIN", "OPERATIONS"],
} as const satisfies Record<string, readonly PlatformAdminRole[]>;

export type AdminPermission = keyof typeof ADMIN_PERMISSIONS;

export function adminCan(role: PlatformAdminRole, permission: AdminPermission): boolean {
  return (ADMIN_PERMISSIONS[permission] as readonly PlatformAdminRole[]).includes(role);
}

// 판매자 권한 (docs/ARCHITECTURE.md 3.3, 대표님 결정 2026-10-02).
// 직원은 대표자가 켠 권한 항목만 가진다. 아래 대표자 전용 기능은 어떤 항목으로도 직원에게 줄 수 없다.
export const STAFF_PERMISSIONS = [
  "BROADCAST_RUN",
  "OVERLAY_EDIT",
  "PRODUCT_MANAGE",
  "ORDER_SHIPPING",
  "CUSTOMER_PII_VIEW",
  "MEMBER_POINTS",
  "INQUIRY_REPLY",
  "RECEIPT_TAX",
  "SALES_VIEW",
  "SHOP_SETTINGS",
] as const satisfies readonly SellerStaffPermission[];

export const OWNER_ONLY_ACTIONS = ["PG_MANAGE", "SUBSCRIPTION_MANAGE", "STAFF_MANAGE", "REWARD_LIVE_PAYOUT"] as const;

export type OwnerOnlyAction = (typeof OWNER_ONLY_ACTIONS)[number];
export type SellerAction = SellerStaffPermission | OwnerOnlyAction;

export type SellerActor = { isOwner: boolean; permissions: readonly SellerStaffPermission[] };

export function isOwnerOnly(action: SellerAction): action is OwnerOnlyAction {
  return (OWNER_ONLY_ACTIONS as readonly string[]).includes(action);
}

export function sellerCan(actor: SellerActor, action: SellerAction): boolean {
  if (actor.isOwner) return true;
  if (isOwnerOnly(action)) return false;
  return actor.permissions.includes(action);
}

export function isStaffPermission(v: unknown): v is SellerStaffPermission {
  return typeof v === "string" && (STAFF_PERMISSIONS as readonly string[]).includes(v);
}

// 마스터 대리 조회(읽기 전용)에서 허용하는 조회. 변경은 항상 거부한다.
export const IMPERSONATION_READ_ACTIONS: readonly SellerAction[] = ["ORDER_SHIPPING", "CUSTOMER_PII_VIEW", "SALES_VIEW", "MEMBER_POINTS", "PRODUCT_MANAGE"];
