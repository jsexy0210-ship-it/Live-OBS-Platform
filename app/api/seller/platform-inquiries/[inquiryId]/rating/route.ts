import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { inquiryStatus, PLATFORM_INQUIRY_MESSAGES, rateMyInquiry } from "../../../../../../lib/server/platform-inquiries/service";

// 「답변이 도움이 됐습니까?」 평가(SA-115). 본문 { helpful: boolean }(도움됨 true · 아니요 false). 문의 전체에 한 번만, 플랫폼 답변이 있은 뒤에만.
// 200 { helpful } · 404 없거나 볼 수 없음 · 409 already_rated·no_reply_yet · 400 invalid_helpful · 403 마스터 대리 조회
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ inquiryId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const r = await rateMyInquiry(prisma, ctx, (await params).inquiryId, await readJson(req), requestMeta(req));
  if (!r) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  return noStore(NextResponse.json({ helpful: r.helpful }));
});
