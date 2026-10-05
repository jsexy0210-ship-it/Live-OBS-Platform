import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { listGradeChanges } from "../../../../../lib/server/shop-member-grades/service";

// 「변동 회원 보기」(SA-044, MEMBER_POINTS 조회): 최근 등급 변경 100건. ?kind=up(승급) · down(강등), 없으면 직접 조정 포함 전체.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listGradeChanges(prisma, ctx, { kind: new URL(req.url).searchParams.get("kind") ?? undefined })));
  } catch (e) {
    return errorResponse(e);
  }
}
