import { NextResponse } from "next/server";
import { reassignJobServer } from "../../../../../../../lib/server/automation/admin";
import { isJobId } from "../../../../../../../lib/server/automation/ids";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";

// 담당 작업 서버 바꾸기(MA-111): 임대가 끝난 실행 중 작업을 회수해 대기열로 돌린다. 정상 임대 중이면 409 lease_active, 시도를 다 쓰게 되면 409 attempts_exhausted.
// 마스터 관리자 운영 역할 이상(조회 전용·CS 불가), body { reason }(1~200자). 결제는 바꾸지 않는다. 같은 출처 요청만(mutation).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.manage");
  const { jobId } = await params;
  if (!isJobId(jobId)) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  const body = await readJson<{ reason: string }>(req);
  const r = await reassignJobServer(prisma, admin, jobId, body.reason, requestMeta(req));
  if (r.ok) return noStore(NextResponse.json(r));
  const status = r.reason === "not_found" ? 404 : r.reason === "bad_reason" ? 400 : 409;
  return noStore(NextResponse.json({ error: r.reason }, { status }));
});
