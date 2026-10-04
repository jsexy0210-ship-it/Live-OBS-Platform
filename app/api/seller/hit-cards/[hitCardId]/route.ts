import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { deleteHitCard } from "../../../../../lib/server/broadcast/hitCards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// HIT 카드 해제(잘못 등록한 카드 지우기). 다른 판매자 카드는 404. 권한은 목록과 같다.
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ hitCardId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  await deleteHitCard(prisma, ctx, (await params).hitCardId, requestMeta(req));
  return NextResponse.json({ ok: true });
});
