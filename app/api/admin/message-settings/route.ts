import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { getAdminMessageSettings, updateAdminMessageSettings } from "../../../../lib/server/messaging/settings";

// 발송 설정(충전 스위치·플랫폼 메일 한도)·채널별 단가·플랜별 제공량·이번 달 플랫폼 메일 사용. 보기는 platform.read.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return NextResponse.json(await getAdminMessageSettings(prisma, admin), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 바꾸기는 최고관리자만. 본문 { chargingEnabled?, platformDailyLimit?, platformMonthlyLimit? }. 빼고 보내면 지금 값 유지.
export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.price");
  const body = await readJson<{ chargingEnabled?: unknown; platformDailyLimit?: unknown; platformMonthlyLimit?: unknown }>(req);
  const r = await updateAdminMessageSettings(prisma, admin, body, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: "invalid_message_settings", message: "입력한 값을 확인해 주십시오" }, { status: 400 });
  return NextResponse.json(r.settings);
});
