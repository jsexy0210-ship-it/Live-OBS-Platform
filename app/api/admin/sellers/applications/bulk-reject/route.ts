import { NextResponse } from "next/server";
import { bulkReject } from "../../../../../../lib/server/admin/signupApplications";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 선택 반려(MA-013). 본문 { sellerIds: string[1~50], reason: 1~200자 }. 건별 결과는 선택 승인과 같다. 최고관리자·운영만.
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const body = await readJson<{ sellerIds: unknown; reason: unknown }>(req);
  const r = await bulkReject(prisma, admin, body?.sellerIds, body?.reason, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  return NextResponse.json(r);
});
