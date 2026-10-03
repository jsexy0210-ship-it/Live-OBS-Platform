import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { staffLinkStatus } from "../../../../../lib/server/sellers/staffIdentity";

// 로그인한 직원의 본인확인 연결 상태 { phoneRegistered, linked }(첫 로그인 안내용, 건너뛸 수 있음). 대표자·마스터 대리 조회는 403.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    return NextResponse.json(await staffLinkStatus(prisma, ctx), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
