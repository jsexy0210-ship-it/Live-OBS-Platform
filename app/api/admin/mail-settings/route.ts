import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { getAdminMailSettings, updateAdminMailSettings } from "../../../../lib/server/mail/settings";

// 메일 설정(통당 초과 단가·플랫폼 무료 한도)·플랜별 월 제공량·이번 달 플랫폼 사용 현황. 보기는 platform.read.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return NextResponse.json(await getAdminMailSettings(prisma, admin), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 바꾸기는 최고관리자만(billing.price). 본문 { overageUnitPrice?, platformDailyLimit?, platformMonthlyLimit? }(0 이상 정수). 빼고 보내면 지금 값 유지.
export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.price");
  const body = await readJson<{ overageUnitPrice?: unknown; platformDailyLimit?: unknown; platformMonthlyLimit?: unknown }>(req);
  const r = await updateAdminMailSettings(prisma, admin, body, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: "invalid_mail_settings", message: "단가(0~100,000원)와 한도(0 이상 정수)를 확인해 주십시오" }, { status: 400 });
  return NextResponse.json(r.settings);
});
