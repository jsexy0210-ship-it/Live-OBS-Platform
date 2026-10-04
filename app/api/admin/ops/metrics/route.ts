import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { opsMetrics } from "../../../../../lib/server/ops/metrics";

// 운영 지표(마스터 관리자 최고관리자만, system.manage): DB 지연·연결 수, 정기 실행 heartbeat, 작업 큐 적체(아직 not_measured),
// 인프라 감시 사건(열린 사건·최근 50개). 공개 /api/health에는 넣지 않는다.
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
    return NextResponse.json(await opsMetrics(prisma), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
