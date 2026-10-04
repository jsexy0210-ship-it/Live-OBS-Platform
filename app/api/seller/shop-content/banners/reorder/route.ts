import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { CONTENT_MESSAGES, reorder } from "../../../../../../lib/server/shop-content/service";

// 홈 배너 순서 바꾸기. 본문 { ids }에 지금 있는 항목을 빠짐없이 새 순서로 담는다(다르면 409 order_conflict).
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await reorder(prisma, ctx, "banner", await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: CONTENT_MESSAGES[r.reason] }, { status: 409 });
  return NextResponse.json({ ok: true });
});
