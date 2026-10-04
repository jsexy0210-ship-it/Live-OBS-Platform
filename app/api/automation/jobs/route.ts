import { NextResponse } from "next/server";
import { listJobs } from "../../../../lib/server/automation/jobs";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

// 내 자동 연결 작업 목록(대표자 전용). 잠금 중에도 이미 산 작업의 진행은 볼 수 있다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
    return noStore(NextResponse.json({ jobs: await listJobs(prisma, ctx) }));
  } catch (e) {
    return errorResponse(e);
  }
}
