import { NextResponse } from "next/server";
import { getAdminSellerSubscription } from "../../../../../../lib/server/admin/sellerSubscription";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";

// 파트너스 상세 「구독」 탭(MA-012-3). 마스터 관리자 전 역할(조회 전용 포함, platform.read), 조회만. 요금제 카드 값은 GET /api/admin/sellers/{sellerId}의 subscription 블록을 쓴다.
// ?cursor&limit(기본 20·최대 100) → { history: [{ at, kind, text }](최신순 최대 100개), trial: { startedAt, endsAt, days } | null,
//   invoices: { items, total, nextCursor }, totals: { paidAmount, paidCount, refundedAmount, refundedCount } }.
// invoices.items는 청구·결제 내역(MA-024)과 같은 모양(state·at·amount·planName·periodStart/End·receipt·receiptUrl·failureReason·refund·canRetry, 예정 포함)이고
// 체험은 kind=TRIAL 0원 항목이 마지막 쪽 끝에 붙는다(total·nextCursor에는 안 셈). 잘못된 cursor·limit는 400, 없는 파트너스는 404.
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const q = new URL(req.url).searchParams;
    const r = await getAdminSellerSubscription(prisma, admin, (await params).sellerId, { cursor: q.get("cursor"), limit: q.get("limit") });
    if (!r.ok) return r.reason === "not_found" ? NextResponse.json({ error: "not_found" }, { status: 404 }) : NextResponse.json({ error: "bad_request" }, { status: 400 });
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return errorResponse(e);
  }
}
