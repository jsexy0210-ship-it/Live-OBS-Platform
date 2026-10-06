import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { listRelatedOptions } from "../../../../../lib/server/platform-inquiries/service";

// 문의 작성의 「관련 주문 · 방송」 선택 목록(SA-114). 이 쇼핑몰의 최근 방송 20개·최근 주문 20개(최신순). 파트너스 계정 누구나, 잠김·정지 중에도.
// 응답 { broadcasts: [{ id, title(없을 수 있음), startedAt }], orders: [{ id, orderNoLabel, nickname, createdAt }] }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return noStore(NextResponse.json(await listRelatedOptions(prisma, ctx)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
