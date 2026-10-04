import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { sellerFeatures } from "../../../../lib/server/billing/features";
import { sellerAccessFor } from "../../../../lib/server/billing/subscription";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

export async function GET(req: Request) {
  try {
    // 체험하기가 끝나도 열린다(화면이 구독·결제로 안내하려면 이용 상태가 필요).
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
    const [access, features] = await Promise.all([sellerAccessFor(prisma, ctx.sellerId), sellerFeatures(prisma, ctx.sellerId)]);
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
