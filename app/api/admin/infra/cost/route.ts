import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { infraCost } from "../../../../../lib/server/ops/infraCost";

// 이번 달 비용 추정(MA-120, 최고관리자만). 모두 「추정」: 마스터가 넣은 단가 × 센 사용량. 실제 금액(actual)은 청구 조회 연결 전까지 null.
// → { checkedAt, month, estimated, actual, actualSource, prices, priceVersion, items[{key,kind,status,unitPrice,usage,accruedWon,projectedWon}], limited[{key,usedWon,limitWon,stopped,stoppedAt}], totals{accruedWon,projectedWon} }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
    return noStore(NextResponse.json(await infraCost(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
