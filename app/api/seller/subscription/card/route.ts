import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { billingProvider } from "../../../../../lib/server/billing/registry";
import { registerCardAndPay } from "../../../../../lib/server/billing/subscription";
import { prisma } from "../../../../../lib/server/db";
import { isString, mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";

// 카드 등록(교체) 후 필요하면 바로 결제(대표자 전용). 체험하기가 끝나도 열린다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), new Date(), { allowUnpaid: true });
  const body = await readJson<{ authKey: string }>(req);
  if (!isString(body.authKey)) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const r = await registerCardAndPay(prisma, billingProvider(), ctx, { authKey: body.authKey });
  if (!r.ok) {
    const status = r.reason === "payment_in_progress" ? 409 : r.reason === "plan_missing" ? 500 : 402;
    return NextResponse.json({ error: r.reason }, { status });
  }
  return NextResponse.json(r);
});
