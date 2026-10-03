import { NextResponse } from "next/server";
import { requestRefund } from "../../../../../../lib/server/automation/jobs";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 환불 요청: 실패로 끝났거나 연결 시작 전 취소한 작업만. 환불 처리 대기까지이고 실제 환불은 승인 뒤에 한다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const { jobId } = await params;
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
  if (!UUID.test(jobId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await requestRefund(prisma, ctx, jobId);
  return noStore(r.ok ? NextResponse.json(r.job) : NextResponse.json({ error: r.reason }, { status: 409 }));
});
