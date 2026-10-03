import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { updateTrialLimits } from "../../../../../../lib/server/billing/trialLimits";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 체험하기 한도 변경(알림톡·문자 건수, 구매자 휴대폰 본인확인 건수, 저장 용량 MB).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ code: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.manage");
  const { code } = await params;
  const body = await readJson<{ message: number; identity: number; storageMb: number }>(req);
  const r = await updateTrialLimits(prisma, admin, code.slice(0, 50), { message: body.message, identity: body.identity, storageMb: body.storageMb }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : 400 });
  return NextResponse.json(r.limits);
});
