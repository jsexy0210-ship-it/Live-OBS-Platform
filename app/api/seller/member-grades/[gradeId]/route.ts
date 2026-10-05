import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { gradeError } from "../../../../../lib/server/shop-member-grades/http";
import { deleteMemberGrade } from "../../../../../lib/server/shop-member-grades/service";

// 등급 삭제: 기본 등급(일반)만 못 지운다(409 base_grade_fixed). 회원이 있으면 모두 기본 등급으로 옮기고(moved) 다음 재산정 때 기준에 맞는 등급으로 올라간다.
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ gradeId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { gradeId } = await params;
  const r = await deleteMemberGrade(prisma, ctx, gradeId);
  return r.ok ? noStore(NextResponse.json({ ok: true, moved: r.moved })) : gradeError(r.reason);
});
