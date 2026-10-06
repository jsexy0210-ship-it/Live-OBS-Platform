import { NextResponse } from "next/server";
import { getSellerShop } from "../../../../../../lib/server/admin/sellerShop";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 파트너스 상세 「쇼핑몰」 탭(MA-012). 마스터 관리자 전 역할 읽기 전용(변경은 파트너스 쇼핑몰 설정에서만).
// → { operatingState, shopName, tagline, slug, brandColor, primaryAddressKind, domains, topNotice, usageGuide, policyChecks, reportCount, products, members, month, topProducts }. 없는 파트너스 404.
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const { sellerId } = await params;
    const r = UUID.test(sellerId) ? await getSellerShop(prisma, admin, sellerId) : null;
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return noStore(NextResponse.json(r));
  } catch (e) {
    return errorResponse(e);
  }
}
