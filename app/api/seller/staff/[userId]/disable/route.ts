import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { disableStaff } from "../../../../../../lib/server/sellers/staff";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 직원 비활성화(대표자 전용). 로그인을 막고 기존 세션을 모두 끊는다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ userId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "ACCOUNT" });
  const { userId } = await params;
  if (!UUID.test(userId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(await disableStaff(prisma, ctx, { staffUserId: userId }, requestMeta(req)));
});
