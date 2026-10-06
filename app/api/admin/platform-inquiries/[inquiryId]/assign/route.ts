import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { assignInquiry, inquiryStatus, PLATFORM_INQUIRY_MESSAGES } from "../../../../../../lib/server/platform-inquiries/service";

// 담당 배정·변경·해제(MA-051·052 「담당 변경」). 최고관리자·운영·CS. 본문 { assigneeId: 관리자 id | null(해제) }. 담당만 바꾸며 version은 그대로다.
// 200 { inquiry } · 400 invalid_assignee(없거나 정지된 관리자·담당할 수 없는 역할) · 404 · 409 inquiry_closed
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ inquiryId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.assign");
  const r = await assignInquiry(prisma, admin, (await params).inquiryId, await readJson(req), requestMeta(req));
  if (r.ok) return noStore(NextResponse.json({ inquiry: r.inquiry }));
  if (r.reason === "not_found") return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
});
