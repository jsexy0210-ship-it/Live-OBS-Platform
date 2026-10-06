import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { completeReceiptIssues } from "../../../../../lib/server/receipts/manual";

// 선택 발행 완료 처리(SA-024, RECEIPT_TAX): body { ids: string[] } 최대 50건. 건마다 처리해 { results: [{ id, ok, reason? }], completed }. ids가 비었거나 너무 많으면 400.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await completeReceiptIssues(prisma, ctx, (await readJson<{ ids: unknown }>(req)).ids);
  if (!r.ok) return NextResponse.json({ error: "invalid_ids", message: "처리할 신청을 확인해 주십시오" }, { status: 400 });
  return noStore(NextResponse.json({ results: r.results, completed: r.completed }));
});
