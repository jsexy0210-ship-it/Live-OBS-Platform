import { NextResponse } from "next/server";
import { getPublicPlan } from "../../../lib/server/billing/plans";
import { prisma } from "../../../lib/server/db";
import { errorResponse } from "../../../lib/server/http/route";

// 빌드 때 미리 만들지 않는다(가격은 요청마다 DB에서 읽음).
export const dynamic = "force-dynamic";

// 요금 안내(공개). 정가·판매가는 DB 값이라 코드 수정 없이 바뀐다.
export async function GET() {
  try {
    const plan = await getPublicPlan(prisma);
    if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(plan);
  } catch (e) {
    return errorResponse(e);
  }
}
