import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { updatePlanMailQuota } from "../../../../../../lib/server/messaging/settings";

// 플랜별 월 거래 메일 제공량(통) 변경. 최고관리자만. 본문 { monthlyQuota(0 이상 정수), effectiveAt?(ISO 시각, 빼거나 지난 시각이면 바로) }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ code: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.price");
  const { code } = await params;
  const body = await readJson<{ monthlyQuota?: unknown; effectiveAt?: unknown }>(req);
  const r = await updatePlanMailQuota(prisma, admin, code.slice(0, 50), body, requestMeta(req));
  if (!r.ok) {
    if (r.reason === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: "invalid_quota", message: "월 제공량(0 이상 정수)과 적용 시각을 확인해 주십시오" }, { status: 400 });
  }
  return NextResponse.json(r.plan);
});
