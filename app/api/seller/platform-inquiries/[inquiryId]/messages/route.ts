import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { addSellerMessage, inquiryStatus, PLATFORM_INQUIRY_MESSAGES } from "../../../../../../lib/server/platform-inquiries/service";

// 추가 문의(SA-115). 본문 { body, imageIds?: 최대 5, fileIds?: 사진 외 파일(사진과 합쳐 5개·20MB) }. 답변 대기로 돌아간다. 201 { inquiry } · 404 · 409 inquiry_closed
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ inquiryId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const r = await addSellerMessage(prisma, ctx, (await params).inquiryId, await readJson(req), requestMeta(req));
  if (!r) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  return noStore(NextResponse.json({ inquiry: r.inquiry }, { status: 201 }));
});
