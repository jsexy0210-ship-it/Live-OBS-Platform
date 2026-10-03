import { NextResponse } from "next/server";
import { resumeJob } from "../../../../../../lib/server/automation/jobs";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 고객 행동(로그인·인증·권한 승인·로컬 도구 연결)을 마쳤어요 → 자동으로 이어 간다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const { jobId } = await params;
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
  if (!UUID.test(jobId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await resumeJob(prisma, ctx, jobId);
  return noStore(r.ok ? NextResponse.json(r.job) : NextResponse.json({ error: r.reason }, { status: 409 }));
});
