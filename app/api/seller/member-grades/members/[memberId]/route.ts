import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { gradeError } from "../../../../../../lib/server/shop-member-grades/http";
import { setMemberGrade } from "../../../../../../lib/server/shop-member-grades/service";

// 회원 등급 직접 조정. body { gradeId, lock: boolean }. lock이면 자동 재산정에서 건너뛴다(고정). 정상 회원만(409 member_not_active).
export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ memberId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { memberId } = await params;
  const r = await setMemberGrade(prisma, ctx, memberId, await readJson<{ gradeId: unknown; lock: unknown }>(req));
  return r.ok ? noStore(NextResponse.json({ changed: r.changed })) : gradeError(r.reason);
});
