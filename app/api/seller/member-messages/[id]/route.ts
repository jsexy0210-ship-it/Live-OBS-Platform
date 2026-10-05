import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { messageError } from "../../../../../lib/server/shop-member-messages/http";
import { getMessage, updateMessage } from "../../../../../lib/server/shop-member-messages/service";

type Ctx = { params: Promise<{ id: string }> };

// 상세(MEMBER_POINTS 조회): 문구·대상·기록 결과와, 기록 뒤 24시간 안 받는 사람의 결제 주문. 열람·클릭 집계는 실제 발송 채널이 생기기 전에는 없다(reaction: null).
export async function GET(req: Request, { params }: Ctx) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const m = await getMessage(prisma, ctx, (await params).id);
    return noStore(m ? NextResponse.json({ message: m }) : NextResponse.json({ error: "not_found" }, { status: 404 }));
  } catch (e) {
    return errorResponse(e);
  }
}

// 예약 수정(예약일 때만): 제목·문구·채널·예약 시각. 종류·대상은 바꾸지 않는다.
export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateMessage(prisma, ctx, (await params).id, await readJson<Record<string, unknown>>(req));
  if (!r.ok) return messageError(r.reason, "suggestedAt" in r ? { suggestedAt: r.suggestedAt } : {});
  return noStore(NextResponse.json({ message: r.message }));
});
