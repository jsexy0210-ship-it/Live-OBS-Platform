import { NextResponse } from "next/server";
import { getPolicyOverview } from "../../../../../lib/server/admin/policyOverview";
import { PLATFORM_POLICY_MESSAGES, readPlatformPolicy, updatePlatformPolicy } from "../../../../../lib/server/admin/platformPolicy";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 플랫폼 기본 정책(MA-081, 읽기 전용). 마스터 관리자 전 역할 조회. 바꾸기는 응답의 edit에 적은 기존 API(최고관리자만).
// → { plans, message, maintenance, assistant: { settings, keyConfigured, available, month, usedMilliWon }, edit,
//     policy: [{ key, group, kind: "int"|"bool"|"enum", unit, value, default, min?, max?, options?, applied, updatedAt }] }
// policy는 저장하는 기본 정책 값(키는 lib/server/admin/platformPolicy.ts). applied=false인 값은 저장만 하고 아직 기능이 읽지 않는다(화면 「적용 예정」).
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json({ ...(await getPolicyOverview(prisma, admin)), policy: await readPlatformPolicy(prisma) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 기본 정책 바꾸기(최고관리자만). 본문 { values: { [key]: number | boolean } }(바꿀 키만, 나머지는 유지).
// 200 { changed: string[], policy } · 400 invalid_policy(+field)·price_notice_min · 403
export const PATCH = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await updatePlatformPolicy(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_POLICY_MESSAGES[r.reason], ...("field" in r ? { field: r.field } : {}) }, { status: 400 }));
  return noStore(NextResponse.json({ changed: r.changed, policy: r.policy }));
});
