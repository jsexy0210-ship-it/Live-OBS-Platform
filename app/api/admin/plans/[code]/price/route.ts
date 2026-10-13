import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { updatePlanPrice } from "../../../../../../lib/server/billing/plans";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 요금제 가격 변경(정가·판매가, 부가세 포함 원). 최고관리자만. 기존 구독자는 필수 고지 완료 + 30일 뒤 첫 결제부터.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ code: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.price");
  const { code } = await params;
  const body = await readJson<{ listPrice: number; salePrice: number }>(req);
  const r = await updatePlanPrice(prisma, admin, code.slice(0, 50), { listPrice: body.listPrice, salePrice: body.salePrice }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : 400 });
  return NextResponse.json(r.plan);
});
