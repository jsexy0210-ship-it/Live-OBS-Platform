import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { listSellersToReview } from "../../../../../lib/server/sellers/approval";

// 마스터 콘솔 「확인 필요」: 자동 승인되지 않은 가입 신청과 걸린 항목.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return NextResponse.json({ sellers: await listSellersToReview(prisma, admin) });
  } catch (e) {
    return errorResponse(e);
  }
}
