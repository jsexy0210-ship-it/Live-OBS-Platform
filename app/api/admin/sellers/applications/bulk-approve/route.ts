import { NextResponse } from "next/server";
import { bulkApprove } from "../../../../../../lib/server/admin/signupApplications";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 선택 승인(MA-013). 본문 { sellerIds: string[1~50], confirmReviewed?: boolean }. 건별 결과 { results[{ sellerId, ok, reason? }], succeeded, failed }.
// 「확인 필요」 사유가 남은 신청은 confirmReviewed: true일 때만 승인한다(없으면 needs_review). 최고관리자·운영만.
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const body = await readJson<{ sellerIds: unknown; confirmReviewed: unknown }>(req);
  const r = await bulkApprove(prisma, admin, body?.sellerIds, { confirmReviewed: body?.confirmReviewed }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  return NextResponse.json(r);
});
