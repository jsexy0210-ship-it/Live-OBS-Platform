import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { getInquiry } from "../../../../../lib/server/platform-inquiries/service";

// 문의 상세(MA-052). 목록 칸 + { closedByAdminName, notice, messages: [{ id, author: PARTNER|PLATFORM, authorName, adminId, body, createdAt, images }] }
export async function GET(req: Request, { params }: { params: Promise<{ inquiryId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const inquiry = await getInquiry(prisma, admin, (await params).inquiryId);
    if (!inquiry) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    return noStore(NextResponse.json({ inquiry }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
