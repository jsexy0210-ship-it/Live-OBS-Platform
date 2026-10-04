import { NextResponse } from "next/server";
import { closeCleanupNeeded } from "../../../../../../../lib/server/automation/admin";
import { isJobId } from "../../../../../../../lib/server/automation/ids";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";

// 「정리 필요」 작업 닫기(마스터 관리자 운영 역할 이상, 조회 전용 불가). body { note }: 사람이 정리한 내용.
// CLEANUP_NEEDED → FAILED, 결제는 환불 처리 대기로. 같은 출처 요청만(mutation).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.manage");
  const { jobId } = await params;
  if (!isJobId(jobId)) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  const body = await readJson<{ note: string }>(req);
  const r = await closeCleanupNeeded(prisma, admin, jobId, body.note, requestMeta(req));
  if (r.ok) return noStore(NextResponse.json(r));
  const status = r.reason === "not_found" ? 404 : r.reason === "invalid_state" || r.reason === "action_in_progress" ? 409 : 400;
  // 진행 중일 수 있는 외부 행동이 끝날 때까지는 닫지 않는다(마스터 관리자 화면, 합니다체)
  const message = r.reason === "action_in_progress" ? "진행 중인 작업 행동이 끝나면 닫을 수 있습니다. 잠시 뒤 다시 시도해 주십시오" : undefined;
  return noStore(NextResponse.json({ error: r.reason, ...(message ? { message } : {}) }, { status }));
});
