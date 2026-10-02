import type { PlatformAdminRole, SellerUserRole } from "@prisma/client";

// 마스터 역할별 권한 표 (docs/ARCHITECTURE.md 3.2). 권한 판단은 이 표 한 곳에서만 한다.
export const ADMIN_PERMISSIONS = {
  "platform.read": ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"],
  "seller.moderate": ["SUPER_ADMIN", "OPERATIONS"],
  "billing.manage": ["SUPER_ADMIN", "OPERATIONS"],
  "support.manage": ["SUPER_ADMIN", "CS"],
  "seller.impersonate": ["SUPER_ADMIN", "OPERATIONS", "CS"],
  "admin.manage": ["SUPER_ADMIN"],
  "system.manage": ["SUPER_ADMIN"],
  "audit.read": ["SUPER_ADMIN", "OPERATIONS", "READ_ONLY"],
} as const satisfies Record<string, readonly PlatformAdminRole[]>;

export type AdminPermission = keyof typeof ADMIN_PERMISSIONS;

export function adminCan(role: PlatformAdminRole, permission: AdminPermission): boolean {
  return (ADMIN_PERMISSIONS[permission] as readonly PlatformAdminRole[]).includes(role);
}

// 판매자 직원 역할별 권한 표 (docs/ARCHITECTURE.md 3.3).
export const SELLER_PERMISSIONS = {
  "broadcast.operate": ["OWNER", "MANAGER", "BROADCASTER"],
  "overlay.manage": ["OWNER", "MANAGER", "BROADCASTER"],
  "product.manage": ["OWNER", "MANAGER"],
  "order.read": ["OWNER", "MANAGER"],
  "order.manage": ["OWNER", "MANAGER"],
  "member.manage": ["OWNER", "MANAGER"],
  "inquiry.manage": ["OWNER", "MANAGER"],
  "reward.manage": ["OWNER", "MANAGER"],
  "reward.livePayout": ["OWNER"],
  "subscription.manage": ["OWNER"],
  "pg.manage": ["OWNER"],
  "staff.manage": ["OWNER"],
} as const satisfies Record<string, readonly SellerUserRole[]>;

export type SellerPermission = keyof typeof SELLER_PERMISSIONS;

export function sellerCan(role: SellerUserRole, permission: SellerPermission): boolean {
  return (SELLER_PERMISSIONS[permission] as readonly SellerUserRole[]).includes(role);
}

// 마스터 대리 조회(읽기 전용)에서 허용하는 판매자 권한: 조회 성격만.
export const IMPERSONATION_READ_PERMISSIONS: readonly SellerPermission[] = ["order.read"];
