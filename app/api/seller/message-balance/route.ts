import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { getSellerMessageBalance, updateLowBalanceThreshold } from "../../../../lib/server/messaging/settings";

// 발송 충전 잔액·채널별 단가·이번 달 메일 사용·비용 안내 동의(대표자 전용). 체험하기가 끝나도·이용 정지 중에도 볼 수 있다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return NextResponse.json(await getSellerMessageBalance(prisma, ctx), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 잔액 부족 알림 기준. 본문 { lowBalanceThreshold }(0~10,000,000원, 0이면 알리지 않음).
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
  const body = await readJson<{ lowBalanceThreshold?: unknown }>(req);
  const r = await updateLowBalanceThreshold(prisma, ctx, { lowBalanceThreshold: body.lowBalanceThreshold });
  if (!r.ok) return NextResponse.json({ error: "invalid_threshold", message: "잔액 부족 알림 기준은 0원에서 1,000만 원 사이로 입력해 주십시오" }, { status: 400 });
  return NextResponse.json(r.balance);
});
