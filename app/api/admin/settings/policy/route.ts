import { NextResponse } from "next/server";
import { getPolicyOverview } from "../../../../../lib/server/admin/policyOverview";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 플랫폼 기본 정책(MA-081, 읽기 전용). 마스터 관리자 전 역할 조회. 바꾸기는 응답의 edit에 적은 기존 API(최고관리자만).
// → { plans, message, maintenance, assistant: { settings, keyConfigured, available, month, usedMilliWon }, edit }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await getPolicyOverview(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
