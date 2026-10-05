import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { closeInquiry, inquiryStatus, PLATFORM_INQUIRY_MESSAGES } from "../../../../../../lib/server/platform-inquiries/service";

// 종료(MA-052). 최고관리자·CS. 본문 { expectedVersion }. 종료하면 파트너스는 더 쓸 수 없다.
// 200 { inquiry } · 404 · 409 inquiry_closed · 409 version_conflict(+currentVersion, 그 사이 추가 문의가 달림)
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ inquiryId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.manage");
  const r = await closeInquiry(prisma, admin, (await params).inquiryId, await readJson(req), requestMeta(req));
  if (r.ok) return noStore(NextResponse.json({ inquiry: r.inquiry }));
  if (r.reason === "not_found") return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  const extra = r.reason === "version_conflict" ? { currentVersion: r.currentVersion } : {};
  return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason], ...extra }, { status: inquiryStatus(r.reason) }));
});
