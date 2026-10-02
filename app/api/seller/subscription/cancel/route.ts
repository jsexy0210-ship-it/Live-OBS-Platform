import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { cancelSubscription } from "../../../../../lib/server/billing/subscription";
import { prisma } from "../../../../../lib/server/db";
import { mutation, sessionToken } from "../../../../../lib/server/http/route";

// 해지(대표자 전용). 이번 이용 기간이 끝날 때까지는 쓸 수 있다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), new Date(), { allowUnpaid: true });
  const r = await cancelSubscription(prisma, ctx);
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 409 });
  return NextResponse.json(r);
});
