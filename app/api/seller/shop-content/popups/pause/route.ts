import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { CONTENT_MESSAGES, setPopupsPaused } from "../../../../../../lib/server/shop-content/service";

// 모든 팝업 잠시 끄기·다시 켜기(SA-065). 본문 { paused: boolean }. 대표자·SHOP_SETTINGS 직원만. 응답 { ok, popupsPaused, pausedAt, pausedByName }.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await setPopupsPaused(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: CONTENT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ ok: true, popupsPaused: r.popupsPaused, pausedAt: r.pausedAt, pausedByName: r.pausedByName });
});
