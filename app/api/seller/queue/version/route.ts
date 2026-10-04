import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { getLiveVersion } from "../../../../../lib/server/queue/read";

// 화면의 15초 주기 확인용. 가진 version과 다르면 /api/seller/queue를 다시 받는다.
// 환불 화면도 보내기 직전에 이 값을 읽는다. 읽기 전용이고, 잠금 중에도 이미 받은 주문의 환불은 열려 있어서
// (대표님 결정 2026-10-02, PRODUCT_SCOPE 「잠금 중 허용 범위」) 잠긴 쇼핑몰에도 돌려준다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "OVERLAY" });
    return NextResponse.json({ version: await getLiveVersion(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}
