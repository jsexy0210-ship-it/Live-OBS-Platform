import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { sellerFeatures } from "../../../../lib/server/billing/features";
import { sellerAccessFor } from "../../../../lib/server/billing/subscription";
import { prisma } from "../../../../lib/server/db";
import { hasOrderFollowup } from "../../../../lib/server/orders/followup";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

export async function GET(req: Request) {
  try {
    // 체험하기가 끝나도 열린다(화면이 구독·결제로 안내하려면 이용 상태가 필요).
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
    const [access, features] = await Promise.all([sellerAccessFor(prisma, ctx.sellerId), sellerFeatures(prisma, ctx.sellerId)]);
    // 후속 처리(이미 받은 주문·구매 제한) 대상이 남았는지. 기능 권한이 하나도 없으면 후속 처리 경로도 막혀 있어 false다(ORDER_FOLLOWUP 가드와 같은 기준).
    const orderFollowup = features.length > 0 && (await hasOrderFollowup(prisma, ctx.sellerId));
    // 상단바용 쇼핑몰·직원 정보. 세션의 sellerId·actorId로만 찾는다(요청 값 사용 안 함).
    const [seller, user] = await Promise.all([
      prisma.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { shopName: true, slug: true, trialEndsAt: true } }),
      prisma.sellerUser.findFirstOrThrow({ where: { id: ctx.actorId, sellerId: ctx.sellerId }, select: { name: true, email: true } }),
    ]);
    return noStore(
      NextResponse.json({
        sellerId: ctx.sellerId,
        userId: ctx.actorId,
        isOwner: ctx.isOwner,
        permissions: ctx.permissions,
        access,
        // 플랜이 준 기능 권한(OVERLAY·EXTERNAL_INTEGRATION·STORE_OPERATIONS). 화면은 메뉴를 고르는 데만 쓰고, 막는 것은 서버가 한다.
        features,
        // true면 플랜이 STORE_OPERATIONS를 주지 않아도(오버레이 전용으로 내린 뒤) 주문·배송·문의 메뉴를 계속 보여 준다. 대상이 다 끝나면 false.
        orderFollowup,
        // 체험 중일 때만 끝나는 시각(직원 화면도 남은 날을 보여 줄 수 있게). 금액·결제 정보는 넣지 않는다.
        trialEndsAt: access === "trial" ? seller.trialEndsAt : null,
        shop: { name: seller.shopName, slug: seller.slug },
        user: { name: user.name, email: user.email },
      }),
    );
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
