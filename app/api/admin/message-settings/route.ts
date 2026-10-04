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

// 바꾸기는 최고관리자만. 충전을 켜려면 발송 충전 정기 작업이 최근 2시간 안에 성공했어야 한다(아니면 409 jobs_not_running). 본문 { chargingEnabled?, platformDailyLimit?, platformMonthlyLimit? }. 빼고 보내면 지금 값 유지.
export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.price");
  const body = await readJson<{ chargingEnabled?: unknown; platformDailyLimit?: unknown; platformMonthlyLimit?: unknown }>(req);
  const r = await updateAdminMessageSettings(prisma, admin, body, requestMeta(req));
  if (!r.ok) {
    if (r.reason === "jobs_not_running") return NextResponse.json({ error: r.reason, message: "충전 정기 작업이 아직 돌지 않아 충전을 켤 수 없습니다" }, { status: 409 });
    return NextResponse.json({ error: r.reason, message: "입력한 값을 확인해 주십시오" }, { status: 400 });
  }
  return NextResponse.json(r.settings);
});
