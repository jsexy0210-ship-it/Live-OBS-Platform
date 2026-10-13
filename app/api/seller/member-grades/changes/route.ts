import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { gradeError } from "../../../../../lib/server/shop-member-grades/http";
import { GradeCursorError, listGradeChanges } from "../../../../../lib/server/shop-member-grades/service";

// 「변동 회원 보기」(SA-044, MEMBER_POINTS 조회): 현재 등급 변경 10건과 다음 커서. ?kind=up(승급) · down(강등), 없으면 직접 조정 포함 전체.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listGradeChanges(prisma, ctx, { kind: new URL(req.url).searchParams.get("kind") ?? undefined, cursor: new URL(req.url).searchParams.get("cursor") })));
  } catch (e) {
    if (e instanceof GradeCursorError) return gradeError("invalid_cursor");
    return errorResponse(e);
  }
}
