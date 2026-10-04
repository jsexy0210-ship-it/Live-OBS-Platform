import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { CONTENT_MESSAGES, deleteBanner, updateBanner } from "../../../../../../lib/server/shop-content/service";

// 홈 배너 수정(PUT, 전체 값)·삭제. 다른 쇼핑몰의 id는 404. 권한은 목록과 같다.
type Ctx = { params: Promise<{ bannerId: string }> };

export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateBanner(prisma, ctx, (await params).bannerId, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: CONTENT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ banner: r.banner });
});

export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  await deleteBanner(prisma, ctx, (await params).bannerId, requestMeta(req));
  return NextResponse.json({ ok: true });
});
