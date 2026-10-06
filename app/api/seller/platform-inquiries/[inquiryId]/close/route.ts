import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { closeMyInquiry, inquiryStatus, PLATFORM_INQUIRY_MESSAGES } from "../../../../../../lib/server/platform-inquiries/service";

// 문의 종료(SA-115 「해결됐습니다 · 종료」). 내가 볼 수 있는 문의(대표자는 쇼핑몰 전부, 직원은 자기 것)만. 본문 { helpful?: boolean }(평가를 함께 남김, 선택).
// 200 { inquiry }(status CLOSED, closedBy PARTNER) · 404 없거나 볼 수 없음 · 409 inquiry_closed(이미 종료) · 400 invalid_helpful · 403 마스터 대리 조회
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ inquiryId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const r = await closeMyInquiry(prisma, ctx, (await params).inquiryId, await readJson(req), requestMeta(req));
  if (!r) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  return noStore(NextResponse.json({ inquiry: r.inquiry }));
});
