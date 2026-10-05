import { NextResponse } from "next/server";
import { IMPERSONATION_COOKIE, IMPERSONATION_VIEW_PERMISSIONS, resolveImpersonation } from "../../../../lib/server/auth/impersonation";
import { unauthenticated } from "../../../../lib/server/authz/errors";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { sellerFeatures } from "../../../../lib/server/billing/features";
import { sellerAccessFor } from "../../../../lib/server/billing/subscription";
import { prisma } from "../../../../lib/server/db";
import { hasOrderFollowup } from "../../../../lib/server/orders/followup";
import { errorResponse, noStore, readCookie, sessionToken } from "../../../../lib/server/http/route";

export async function GET(req: Request) {
  try {
    // 체험하기가 끝나도 열린다(화면이 구독·결제로 안내하려면 이용 상태가 필요).
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const [access, features] = await Promise.all([sellerAccessFor(prisma, ctx.sellerId), sellerFeatures(prisma, ctx.sellerId)]);
    // 후속 처리(이미 받은 주문·구매 제한) 대상이 남았는지. 기능 권한이 하나도 없으면 후속 처리 경로도 막혀 있어 false다(ORDER_FOLLOWUP 가드와 같은 기준).
    const orderFollowup = features.length > 0 && (await hasOrderFollowup(prisma, ctx.sellerId));
    // 상단바용 쇼핑몰·직원 정보. 세션의 sellerId·actorId로만 찾는다(요청 값 사용 안 함).
    // 마스터 대리 조회(MA-016)는 actorId가 관리자라 직원 표에 없다. 열린 대리 조회 정보(누가·왜·언제까지)를 함께 내려 화면이 배너를 띄운다.
    const imp = ctx.readOnly ? await resolveImpersonation(prisma, readCookie(req, IMPERSONATION_COOKIE)) : null;
    if (ctx.readOnly && !imp) throw unauthenticated();
    const [seller, user] = await Promise.all([
      prisma.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { shopName: true, slug: true, trialEndsAt: true, status: true } }),
      imp ? Promise.resolve({ name: imp.adminName, email: "" }) : prisma.sellerUser.findFirstOrThrow({ where: { id: ctx.actorId, sellerId: ctx.sellerId }, select: { name: true, email: true } }),
    ]);
    return noStore(
      NextResponse.json({
        sellerId: ctx.sellerId,
        userId: ctx.actorId,
        isOwner: ctx.isOwner,
        // 대리 조회는 조회가 열린 화면(주문·상품·회원·통계)의 메뉴만 보이게 하는 표시용 권한이다. 변경은 서버가 readOnly로 모두 거부한다.
        permissions: imp ? [...IMPERSONATION_VIEW_PERMISSIONS] : ctx.permissions,
        readOnly: ctx.readOnly,
        impersonation: imp ? { adminName: imp.adminName, reason: imp.reason, startedAt: imp.startedAt, expiresAt: imp.expiresAt } : null,
        access,
        // 플랜이 준 기능 권한(OVERLAY·EXTERNAL_INTEGRATION·STORE_OPERATIONS). 화면은 메뉴를 고르는 데만 쓰고, 막는 것은 서버가 한다.
        features,
        // true면 플랜이 STORE_OPERATIONS를 주지 않아도(오버레이 전용으로 내린 뒤) 주문·배송·문의 메뉴를 계속 보여 준다. 대상이 다 끝나면 false.
        orderFollowup,
        // 체험 중일 때만 끝나는 시각(직원 화면도 남은 날을 보여 줄 수 있게). 금액·결제 정보는 넣지 않는다.
        trialEndsAt: access === "trial" ? seller.trialEndsAt : null,
        // 마스터가 이용 정지했는지(신규만 막기). true면 화면은 정지 안내를 보이고 이미 받은 주문 처리 메뉴만 연다(나머지는 서버가 403 seller_suspended).
        suspended: seller.status === "SUSPENDED",
        shop: { name: seller.shopName, slug: seller.slug },
        user: { name: user.name, email: user.email },
      }),
    );
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
