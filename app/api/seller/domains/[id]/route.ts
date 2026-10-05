import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { DOMAIN_MESSAGES, DOMAIN_STATUS, deleteDomain } from "../../../../../lib/server/seller-settings/domains";

// 도메인 해제(연결 지우기, SHOP_SETTINGS). 없거나 다른 쇼핑몰 도메인은 404.
export const DELETE = mutation(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const t = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { id } = await ctx.params;
  const r = await deleteDomain(prisma, t, id, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: DOMAIN_MESSAGES[r.reason] }, { status: DOMAIN_STATUS[r.reason] });
  return NextResponse.json({ ok: true });
});
