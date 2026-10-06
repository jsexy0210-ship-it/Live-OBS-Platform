import { NextResponse } from "next/server";
import { markCustomerActionDone } from "../../../../../../lib/server/automation/jobs";
import { isJobId } from "../../../../../../lib/server/automation/ids";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";

// 「고객 확인 필요」 할 일 목록에서 한 줄을 「완료」로 표시(SA-152). 본문 { action: "LOGIN"|"TWO_FACTOR"|"CAPTCHA"|"PERMISSION_GRANT"|"LOCAL_TOOL" }. 응답은 작업 조회와 같다(customerChecklist의 done).
// 고객 확인 대기가 아니면 409 invalid_state, 모르는 줄은 400 invalid_action. 표시용이라 작업자 진행은 그대로이고, 「이어서 진행하기」는 resume이 맡는다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const { jobId } = await params;
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "OVERLAY" });
  if (!isJobId(jobId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await markCustomerActionDone(prisma, ctx, jobId, (await readJson<{ action: unknown }>(req)).action);
  return noStore(r.ok ? NextResponse.json(r.job) : NextResponse.json({ error: r.reason }, { status: r.reason === "invalid_action" ? 400 : 409 }));
});
