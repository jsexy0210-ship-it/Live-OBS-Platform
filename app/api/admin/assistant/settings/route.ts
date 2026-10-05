import { NextResponse } from "next/server";
import { ADMIN_ASSISTANT_MESSAGES, getAssistantSettings, updateAssistantSettings } from "../../../../../lib/server/assistant/admin";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 도우미 설정·이번 달 사용량(MA-084). 보기는 모든 역할. 키 값은 주지 않고 설정 여부(keyConfigured)만.
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return NextResponse.json(await getAssistantSettings(prisma), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 바꾸기는 최고관리자만(월 한도 포함, 로그 추적). 본문 { enabled?, model?, inputWonPerMTok?, outputWonPerMTok?, monthlyBudgetWon?, sellerDailyLimit?, expectedVersion? }
// 400 invalid_settings·incomplete_settings(켜려면 모델·단가 필요) · 409 version_conflict
export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await updateAssistantSettings(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) {
    if ("currentVersion" in r) return NextResponse.json({ error: r.reason, message: ADMIN_ASSISTANT_MESSAGES.version_conflict, currentVersion: r.currentVersion }, { status: 409 });
    return NextResponse.json({ error: r.reason, message: ADMIN_ASSISTANT_MESSAGES[r.reason] }, { status: 400 });
  }
  return NextResponse.json(await getAssistantSettings(prisma));
});
