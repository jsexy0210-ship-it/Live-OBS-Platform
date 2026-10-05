import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { returnError } from "../../../../../../lib/server/shop-returns/http";
import { inspectReturn } from "../../../../../../lib/server/shop-returns/service";

// 검수 결과 입력(ORDER_SHIPPING), 회수 완료 단계. body { result: "OK"|"USED_DAMAGED"|"MISSING_PARTS", note?, restock? }. restock는 이상 없음일 때만 재고를 되돌린다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { id } = await params;
  const r = await inspectReturn(prisma, ctx, id, await readJson<Record<string, unknown>>(req));
  if (!r.ok) return returnError(r.reason, "seller");
  return noStore(NextResponse.json({ request: r.request }));
});
