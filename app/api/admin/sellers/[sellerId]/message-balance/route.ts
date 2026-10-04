import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { getAdminSellerMessageBalance, grantSellerMessageBalance } from "../../../../../../lib/server/messaging/settings";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 파트너스 한 곳의 발송 충전 잔액·이번 달 메일 사용(platform.read)
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const { sellerId } = await params;
    const r = UUID.test(sellerId) ? await getAdminSellerMessageBalance(prisma, admin, sellerId) : null;
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 무상 지급(이벤트·보상, 환불 대상 아님). 최고관리자만. 본문 { amount(1~10,000,000원), reason(1~200자), idempotencyKey(같은 키는 한 번만) }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.price");
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ amount?: unknown; reason?: unknown; idempotencyKey?: unknown }>(req);
  const r = await grantSellerMessageBalance(prisma, admin, sellerId, body, requestMeta(req));
  if (!r.ok) {
    if (r.reason === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: "invalid_grant", message: "금액(1원~1,000만 원)·사유(200자 이내)·요청 키를 확인해 주십시오" }, { status: 400 });
  }
  return NextResponse.json({ ledgerId: r.ledgerId, existing: r.existing, balance: r.balance }, { status: r.existing ? 200 : 201 });
});
