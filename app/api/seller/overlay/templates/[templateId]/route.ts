import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { deleteTemplate } from "../../../../../../lib/server/overlay/layout";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 내 템플릿 삭제(지금 레이아웃은 그대로). 다른 쇼핑몰 템플릿·없는 템플릿은 404.
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ templateId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const { templateId } = await params;
  if (!UUID.test(templateId) || !(await deleteTemplate(prisma, ctx, templateId, requestMeta(req)))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
