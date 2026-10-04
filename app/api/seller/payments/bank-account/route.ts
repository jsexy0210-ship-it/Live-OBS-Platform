import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { readBankAccount, saveBankAccount } from "../../../../../lib/server/payments/bank";
import { sellerPaymentErrorBody } from "../../../../../lib/server/payments/messages";

// 무통장 입금 계좌(SHOP_SETTINGS). GET → { account: { bankName, accountNumber, accountHolder } | null }.
// PUT 본문 { bankName(1~20자), accountNumber(숫자·하이픈), accountHolder(1~30자) } → { account }. 틀리면 400 invalid_bank_account.
// 로그 추적에는 계좌번호 끝 4자리만 남긴다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ account: await readBankAccount(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await saveBankAccount(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(sellerPaymentErrorBody(r.reason), { status: 400 });
  return NextResponse.json({ account: r.account });
});
