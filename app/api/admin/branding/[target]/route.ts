import { NextResponse } from "next/server";
import { BRANDING_MESSAGES, updateBrandingText } from "../../../../../lib/server/branding/service";
import { isBrandingTarget } from "../../../../../lib/server/branding/store";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 공유 카드 제목·설명 바꾸기. 본문 { title: string | null, description: string | null }, 빈 값은 기본값으로. 최고관리자만.
export const PUT = mutation(async (req: Request, ctx: { params: Promise<{ target: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const { target } = await ctx.params;
  if (!isBrandingTarget(target)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await updateBrandingText(prisma, admin, target, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: BRANDING_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ branding: r.branding });
});
