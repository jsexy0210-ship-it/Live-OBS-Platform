import { NextResponse } from "next/server";
import { FAVICON_MAX_BYTES, readBodyLimited } from "../../../../../../lib/server/branding/image";
import { imageMessage, resetBrandingImage, setBrandingImage } from "../../../../../../lib/server/branding/service";
import { isBrandingTarget } from "../../../../../../lib/server/branding/store";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

type Ctx = { params: Promise<{ target: string }> };

// 파비콘(PNG·ICO, 256KB까지) 올리기. 본문은 파일 바이트 그대로. 형식은 파일 앞부분 바이트로 확인한다. 최고관리자만.
export const PUT = mutation(async (req: Request, ctx: Ctx) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const { target } = await ctx.params;
  if (!isBrandingTarget(target)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const data = await readBodyLimited(req, FAVICON_MAX_BYTES);
  if (!data) return NextResponse.json({ error: "file_too_large", message: imageMessage("favicon", "file_too_large") }, { status: 413 });
  const r = await setBrandingImage(prisma, admin, target, "favicon", data, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: r.message }, { status: r.reason === "file_too_large" ? 413 : 400 });
  return NextResponse.json({ branding: r.branding });
});

// 기본값으로 되돌리기
export const DELETE = mutation(async (req: Request, ctx: Ctx) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const { target } = await ctx.params;
  if (!isBrandingTarget(target)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await resetBrandingImage(prisma, admin, target, "favicon", requestMeta(req));
  return NextResponse.json({ branding: r.branding });
});
