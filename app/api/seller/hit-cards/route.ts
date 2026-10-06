import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { createHitCard, HIT_MESSAGES, listHitCards } from "../../../../lib/server/broadcast/hitCards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";

// HIT 카드 이력(SA-053). GET ?broadcastId=&grade=SAR|SR|UR|SE|SP|AA&from=YYYY-MM-DD&to=YYYY-MM-DD(KST, 끝 포함)&cursor= →
// { items: [{ id, cardName, grade(없으면 null), note, nickname, broadcast: { id, title } | null, order: { id, orderNo, productLabel } | null, createdAt }], grades(등급 선택지 목록), nextCursor }(최신순 50개).
// 대표자·「방송 진행」(BROADCAST_RUN) 직원만(그 밖 403), 플랜 기능 OVERLAY.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    const q = new URL(req.url).searchParams;
    const r = await listHitCards(prisma, ctx, { broadcastId: q.get("broadcastId"), from: q.get("from"), to: q.get("to"), cursor: q.get("cursor"), grade: q.get("grade") });
    if (!r.ok) return NextResponse.json({ error: r.reason, message: HIT_MESSAGES[r.reason] }, { status: 400 });
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return errorResponse(e);
  }
}

// 등록. 본문: { cardName(60자), grade?(12자 이내 자유 입력·추천 SAR·SR·UR·SE·SP·AA, 형식 오류는 400 invalid_grade·비우면 없음), note?(200자), queueItemId?(주문대기 항목) | nickname?(30자, queueItemId 없을 때) }. 응답 201 { card }.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const r = await createHitCard(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: HIT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ card: r.card }, { status: 201 });
});
