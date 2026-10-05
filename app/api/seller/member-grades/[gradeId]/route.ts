import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { gradeError } from "../../../../../lib/server/shop-member-grades/http";
import { deleteMemberGrade } from "../../../../../lib/server/shop-member-grades/service";

// 등급 삭제: 직접 만든 등급 중 회원이 없는 것만(기본 등급 409 base_grade_fixed, 회원 있음 409 grade_in_use).
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ gradeId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { gradeId } = await params;
  const r = await deleteMemberGrade(prisma, ctx, gradeId);
  return r.ok ? noStore(NextResponse.json({ ok: true })) : gradeError(r.reason);
});
