import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { updateChannelPrice } from "../../../../../lib/server/messaging/settings";

// 채널별 단가(원) 변경. 최고관리자만. 본문 { unitPrice(0~100,000), effectiveAt?(ISO 시각, 빼거나 지난 시각이면 바로) }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ channel: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.price");
  const { channel } = await params;
  const body = await readJson<{ unitPrice?: unknown; effectiveAt?: unknown }>(req);
  const r = await updateChannelPrice(prisma, admin, channel.slice(0, 50), body, requestMeta(req));
  if (!r.ok) {
    if (r.reason === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: "invalid_price", message: "단가(0~100,000원)와 적용 시각을 확인해 주십시오" }, { status: 400 });
  }
  return NextResponse.json(r.price);
});
