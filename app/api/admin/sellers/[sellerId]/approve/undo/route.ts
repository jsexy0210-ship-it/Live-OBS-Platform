import { NextResponse } from "next/server";
import { undoApproval } from "../../../../../../../lib/server/admin/signupApplications";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";

// 승인 되돌리기(MA-013). 내가 승인한 지 10초 안이고 구독 기록이 없을 때만 승인 대기로 되돌린다(409 not_undoable).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const r = await undoApproval(prisma, admin, (await params).sellerId, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : 409 });
  return NextResponse.json(r);
});
