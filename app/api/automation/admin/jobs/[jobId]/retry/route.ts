import { NextResponse } from "next/server";
import { retryJobNow } from "../../../../../../../lib/server/automation/admin";
import { isJobId } from "../../../../../../../lib/server/automation/ids";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";

// 재시도(MA-111): 백오프로 미래에 잡힌 대기(QUEUED) 작업의 실행 시각을 지금으로 당긴다. 종료·실행 중·고객 대기 작업은 409.
// 마스터 관리자 운영 역할 이상(조회 전용·CS 불가), body { reason }(1~200자). 결제는 바꾸지 않는다. 같은 출처 요청만(mutation).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.manage");
  const { jobId } = await params;
  if (!isJobId(jobId)) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  const body = await readJson<{ reason: string }>(req);
  const r = await retryJobNow(prisma, admin, jobId, body.reason, requestMeta(req));
  if (r.ok) return noStore(NextResponse.json(r));
  const status = r.reason === "not_found" ? 404 : r.reason === "bad_reason" ? 400 : 409;
  return noStore(NextResponse.json({ error: r.reason }, { status }));
});
