import { NextResponse } from "next/server";
import { adminJobList, adminJobSummary, isAdminJobFilter } from "../../../../../lib/server/automation/admin";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 자동 연결 작업 목록·요약(MA-110, 조회만, 마스터 관리자 전 역할). ?filter=all|customer|failed|done
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const f = new URL(req.url).searchParams.get("filter") ?? "all";
    if (!isAdminJobFilter(f)) return noStore(NextResponse.json({ error: "bad_filter" }, { status: 400 }));
    const [summary, jobs] = await Promise.all([adminJobSummary(prisma), adminJobList(prisma, f)]);
    return noStore(NextResponse.json({ summary, jobs }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
