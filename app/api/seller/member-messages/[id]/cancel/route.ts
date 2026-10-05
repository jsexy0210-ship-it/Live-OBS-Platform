import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { messageError } from "../../../../../../lib/server/shop-member-messages/http";
import { cancelMessage } from "../../../../../../lib/server/shop-member-messages/service";

// 예약 취소(MEMBER_POINTS, 예약일 때만). 이미 기록된 발송은 취소할 수 없다(409).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await cancelMessage(prisma, ctx, (await params).id);
  return r.ok ? noStore(NextResponse.json({ ok: true })) : messageError(r.reason);
});
