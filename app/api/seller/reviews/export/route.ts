import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { REVIEW_EXPORT_MESSAGES, exportSellerReviews } from "../../../../../lib/server/product-reviews/export";

// 리뷰 내려받기(SA-048 「엑셀 내려받기」, CSV 기본 · ?format=xlsx면 엑셀). 목록(GET /api/seller/reviews)과 같은 조건
// ?status·rating·waiting·from·to·q·field·photo로 거른 리뷰를 5,000건까지. 답글·숨김과 같은 권한(INQUIRY_REPLY)이고 내려받으면 로그 추적(review.export)에 남는다.
// 5,000건을 넘으면 400 too_many_reviews. 응답 머리글 X-Review-Count = 내려받은 건수.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const p = new URL(req.url).searchParams;
    const q = { status: p.get("status"), rating: p.get("rating"), waiting: p.get("waiting"), from: p.get("from"), to: p.get("to"), q: p.get("q"), field: p.get("field"), photo: p.get("photo") };
    const xlsx = p.get("format") === "xlsx";
    const r = await exportSellerReviews(prisma, ctx, q, xlsx ? "xlsx" : "csv");
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: REVIEW_EXPORT_MESSAGES[r.reason] }, { status: 400 }));
    const name = "%EB%A6%AC%EB%B7%B0-%EB%AA%A9%EB%A1%9D";
    if (xlsx) {
      return noStore(new Response(new Uint8Array(r.value.xlsx!), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename*=UTF-8''${name}.xlsx`, "X-Review-Count": String(r.value.count) } }));
    }
    return noStore(new Response(r.value.csv!, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${name}.csv`, "X-Review-Count": String(r.value.count) } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
