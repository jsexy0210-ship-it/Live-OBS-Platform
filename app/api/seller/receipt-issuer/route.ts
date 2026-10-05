import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";
import { readReceiptIssuer, saveReceiptIssuer } from "../../../../lib/server/receipts/issuer";

// 영수증·세금계산서 발행자 정보(SA-024, 파트너스 명의 발행): { issuer: { businessNumber, companyName, representative, certStatus, certCheckedAt } | null }.
// certStatus(NOT_REGISTERED·REGISTERED·EXPIRED)는 발행 업체 연동이 갱신한다. RECEIPT_TAX 권한.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    return noStore(NextResponse.json({ issuer: await readReceiptIssuer(prisma, ctx) }));
  } catch (e) {
    return errorResponse(e);
  }
}

// 저장. body { businessNumber, companyName, representative }. 사업자번호가 바뀌면 인증서 상태는 미등록으로 돌아간다. 잘못된 값은 400 invalid_receipt_issuer. 로그 추적 seller.receipt_issuer.update.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await saveReceiptIssuer(prisma, ctx, await readJson<Record<string, unknown>>(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: "사업자 정보를 확인해 주십시오" }, { status: 400 });
  return noStore(NextResponse.json({ issuer: r.issuer }));
});
