import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { getLiveVersion } from "../../../../../lib/server/queue/read";

// 화면의 15초 주기 확인용. 가진 version과 다르면 /api/seller/queue를 다시 받는다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    return NextResponse.json({ version: await getLiveVersion(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}
