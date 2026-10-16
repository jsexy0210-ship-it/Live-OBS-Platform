import type { ActorType, ImpersonationScope, SellerStaffPermission } from "@prisma/client";
import { AuthError, forbidden } from "../authz/errors";
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
  // 마스터 대리 조회일 때 사유를 적으며 고른 열람 범위(MA-016). 범위 밖 조회는 403 out_of_scope.
  readonly impersonationScopes?: readonly ImpersonationScope[];
};

// 대리 조회에서 조회 권한이 속한 열람 범위. 상품·매출 조회는 지금 열려 있는 화면 중 가까운 「주문」 범위에 둔다.
// 구매자 연락처(CUSTOMER_PII_VIEW)는 어떤 범위에서도 열지 않는다.
const IMPERSONATION_ACTION_SCOPE: Partial<Record<SellerAction, ImpersonationScope>> = {
  ORDER_SHIPPING: "ORDERS",
  SALES_VIEW: "ORDERS",
  PRODUCT_MANAGE: "ORDERS",
  MEMBER_POINTS: "MEMBERS",
};
export const outOfScope = () => new AuthError(403, "out_of_scope");

// 변경 작업 권한 확인. 마스터 대리 조회(읽기 전용)는 항상 거부한다.
export function requireSellerPermission(ctx: TenantContext, action: SellerAction): void {
  if (ctx.readOnly) throw forbidden();
  if (!sellerCan(ctx, action)) throw forbidden();
}

// 조회 권한 확인. 마스터 대리 조회는 정해 둔 조회만 허용한다.
export function requireSellerRead(ctx: TenantContext, action: SellerAction): void {
  if (ctx.readOnly) {
    if (!IMPERSONATION_READ_ACTIONS.includes(action)) throw forbidden();
    if (!impersonationInScope(ctx, action)) throw outOfScope();
    return;
  }
  if (!sellerCan(ctx, action)) throw forbidden();
}

// 대리 조회가 이 조회 권한의 열람 범위 안인지
export function impersonationInScope(ctx: TenantContext, action: SellerAction): boolean {
  const scope = IMPERSONATION_ACTION_SCOPE[action];
  return !!scope && !!ctx.impersonationScopes?.includes(scope);
}

// 오류를 던지지 않는 조회 가능 여부(검색 등 결과를 걸러 주는 곳). 대리 조회는 허용 조회이면서 열람 범위 안일 때만.
export function canReadAction(ctx: TenantContext, action: SellerAction): boolean {
  if (ctx.readOnly) return IMPERSONATION_READ_ACTIONS.includes(action) && impersonationInScope(ctx, action);
  return sellerCan(ctx, action);
}

// 구매자 이름·연락처·주소를 응답에 넣어도 되는지(CUSTOMER_PII_VIEW). 없으면 응답에서 그 필드를 뺀다.
export function canViewCustomerPii(ctx: TenantContext): boolean {
  // 마스터 대리 조회는 어떤 범위에서도 구매자 이름·연락처·주소를 보지 못한다(MA-016)
  if (ctx.readOnly) return false;
  return sellerCan(ctx, "CUSTOMER_PII_VIEW");
}

export function assertWritable(ctx: TenantContext): void {
  if (ctx.readOnly) throw forbidden();
}
