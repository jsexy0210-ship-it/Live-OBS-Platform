import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { updatePlanPrice } from "../../../../../../lib/server/billing/plans";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 요금제 가격 변경(정가·판매가, 부가세 포함 원). 다음 결제부터 적용된다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ code: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.manage");
  const { code } = await params;
  const body = await readJson<{ listPrice: number; salePrice: number }>(req);
  const r = await updatePlanPrice(prisma, admin, code.slice(0, 50), { listPrice: body.listPrice, salePrice: body.salePrice }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : 400 });
  return NextResponse.json(r.plan);
});
