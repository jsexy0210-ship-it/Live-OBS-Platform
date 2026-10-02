import type { ActorType, SellerStaffPermission } from "@prisma/client";
import { forbidden } from "../authz/errors";
import { IMPERSONATION_READ_ACTIONS, sellerCan, type SellerAction } from "../authz/permissions";

// 판매자 데이터 접근은 모두 이 컨텍스트를 거친다. sellerId는 세션에서만 얻고 요청 값은 쓰지 않는다.
export type TenantContext = {
  readonly sellerId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  // 판매자 대표자 여부와 직원 권한 항목. 마스터 대리 조회면 isOwner=false, permissions=[]
  readonly isOwner: boolean;
  readonly permissions: readonly SellerStaffPermission[];
  readonly readOnly: boolean;
};

// 변경 작업 권한 확인. 마스터 대리 조회(읽기 전용)는 항상 거부한다.
export function requireSellerPermission(ctx: TenantContext, action: SellerAction): void {
  if (ctx.readOnly) throw forbidden();
  if (!sellerCan(ctx, action)) throw forbidden();
}

// 조회 권한 확인. 마스터 대리 조회는 정해 둔 조회만 허용한다.
export function requireSellerRead(ctx: TenantContext, action: SellerAction): void {
  if (ctx.readOnly) {
    if (!IMPERSONATION_READ_ACTIONS.includes(action)) throw forbidden();
    return;
  }
  if (!sellerCan(ctx, action)) throw forbidden();
}

// 구매자 이름·연락처·주소를 응답에 넣어도 되는지(CUSTOMER_PII_VIEW). 없으면 응답에서 그 필드를 뺀다.
export function canViewCustomerPii(ctx: TenantContext): boolean {
  if (ctx.readOnly) return true;
  return sellerCan(ctx, "CUSTOMER_PII_VIEW");
}

export function assertWritable(ctx: TenantContext): void {
  if (ctx.readOnly) throw forbidden();
}
