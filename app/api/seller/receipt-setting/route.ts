import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";
import { readReceiptSetting, saveReceiptSetting } from "../../../../lib/server/receipts/manual";
import { SELLER_RECEIPT_MESSAGES } from "../../../../lib/server/receipts/service";

// 영수증·세금계산서 발행 방식(SA-024 「발행 방식」, RECEIPT_TAX): { issueMode: DIRECT | AUTO }. 기본 DIRECT(직접 발행 후 완료 처리).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    return noStore(NextResponse.json(await readReceiptSetting(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

// 저장. body { issueMode }. AUTO(자동 발행)는 발행 업체 연동 전이라 409 auto_unavailable(준비 중), 모르는 값은 400 invalid_mode. 변경은 로그 추적(receipt_setting.update).
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await saveReceiptSetting(prisma, ctx, await readJson<Record<string, unknown>>(req));
  if (!r.ok) {
    return r.reason === "auto_unavailable"
      ? NextResponse.json({ error: r.reason, message: SELLER_RECEIPT_MESSAGES.auto_unavailable }, { status: 409 })
      : NextResponse.json({ error: r.reason, message: "발행 방식을 확인해 주십시오" }, { status: 400 });
  }
  return noStore(NextResponse.json({ issueMode: r.issueMode }));
});
