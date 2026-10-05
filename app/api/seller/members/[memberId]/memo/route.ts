import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { getMemberMemo, putMemberMemo } from "../../../../../../lib/server/buyers/memberMemo";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";

// 회원 메모(MEMBER_POINTS). 잠금 중에도 이미 받은 주문의 고객 응대를 위해 보고 적을 수 있다(회원 상세와 같은 기준).
// GET → { memo: { body, createdAt, updatedAt, updatedBy: { name } | null } | null }. 탈퇴·다른 쇼핑몰 회원은 404.
export async function GET(req: Request, { params }: { params: Promise<{ memberId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    return noStore(NextResponse.json({ memo: await getMemberMemo(prisma, ctx, (await params).memberId) }));
  } catch (e) {
    return errorResponse(e);
  }
}

// PUT 본문: { body: string(1,000자 이하, 줄바꿈 허용) }. 빈 글이면 메모를 지우고 { memo: null }. 글자가 잘못되면 400 invalid_memo.
export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ memberId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const b = await readJson<{ body: unknown }>(req);
  const r = await putMemberMemo(prisma, ctx, (await params).memberId, b.body);
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return noStore(NextResponse.json({ memo: r.memo }));
});
