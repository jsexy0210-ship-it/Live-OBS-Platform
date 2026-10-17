import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { deleteHitCards, HIT_MESSAGES } from "../../../../../lib/server/broadcast/hitCards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// HIT 카드 선택 삭제(SA-053 「선택한 카드 지우기」). 본문 { ids: string[](1~100) } → { deleted, missing }(내 몰에 없는 id는 missing으로만 센다).
// 복구 없는 영구 삭제, 방송 화면 노출 중인 카드도 지울 수 있다. 형식 오류는 400 { error: "invalid_ids", message }. BROADCAST_RUN 쓰기 권한, 플랜 OVERLAY.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const r = await deleteHitCards(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: HIT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ deleted: r.deleted, missing: r.missing });
});
