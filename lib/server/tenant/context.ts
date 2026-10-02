import type { ActorType, SellerUserRole } from "@prisma/client";
import { forbidden } from "../authz/errors";
import { IMPERSONATION_READ_PERMISSIONS, sellerCan, type SellerPermission } from "../authz/permissions";

// 판매자 데이터 접근은 모두 이 컨텍스트를 거친다. sellerId는 세션에서만 얻고 요청 값은 쓰지 않는다.
export type TenantContext = {
  readonly sellerId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  // 판매자 직원이면 역할, 마스터 대리 조회면 null
  readonly sellerRole: SellerUserRole | null;
  readonly readOnly: boolean;
};

export function requireSellerPermission(ctx: TenantContext, permission: SellerPermission): void {
  if (ctx.readOnly) {
    if (!IMPERSONATION_READ_PERMISSIONS.includes(permission)) throw forbidden();
    return;
  }
  if (!ctx.sellerRole || !sellerCan(ctx.sellerRole, permission)) throw forbidden();
}

export function assertWritable(ctx: TenantContext): void {
  if (ctx.readOnly) throw forbidden();
}
