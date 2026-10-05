import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { listSellerInquiries, SELLER_INQUIRY_MESSAGES } from "../../../../lib/server/buyer-inquiries/service";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

// 구매자 문의 목록(SA-046). ?status(WAITING|ANSWERED)·kind(PRODUCT|GENERAL)·from·to(KST 날짜, 작성일, 끝 포함)·q(제목·내용·작성자·상품명)·cursor. 응답 { inquiries, nextCursor, waitingCount, canEdit }. 조회는 같은 쇼핑몰 파트너스 계정 누구나.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const q = new URL(req.url).searchParams;
    const r = await listSellerInquiries(prisma, ctx, { status: q.get("status"), kind: q.get("kind"), from: q.get("from"), to: q.get("to"), q: q.get("q"), cursor: q.get("cursor") }, "/api/seller/inquiries/images");
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: SELLER_INQUIRY_MESSAGES[r.reason] }, { status: 400 }));
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return errorResponse(e);
  }
}
