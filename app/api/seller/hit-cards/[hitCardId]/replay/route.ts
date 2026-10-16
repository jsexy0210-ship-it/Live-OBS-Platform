import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { replayHitCard } from "../../../../../../lib/server/broadcast/hitCards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// HIT 카드 다시 연출(SA-053 「다시 연출」). 지금 방송의 카드만(아니면 409 { error: "not_live" }), 다른 판매자 카드는 404. 권한은 BROADCAST_RUN 쓰기.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ hitCardId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const r = await replayHitCard(prisma, ctx, (await params).hitCardId, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: "지금 방송 중인 카드만 다시 연출할 수 있습니다" }, { status: 409 });
  return NextResponse.json({ ok: true });
});
