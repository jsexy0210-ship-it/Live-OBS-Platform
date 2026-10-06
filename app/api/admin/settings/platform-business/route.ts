import { NextResponse } from "next/server";
import { PLATFORM_BUSINESS_MESSAGES, readPlatformBusinessInfo, updatePlatformBusinessInfo } from "../../../../../lib/server/admin/platformBusinessInfo";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 플랫폼(ONQ) 사업자 정보: 파트너스 가입 안내 메일(승인·반려·보완) 바닥글에 쓴다. 조회는 마스터 관리자 전 역할.
// → { name, representative, businessNumber, address, phone, complete(모든 칸이 차 있으면 true), updatedAt }
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await readPlatformBusinessInfo(prisma)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 바꾸기(최고관리자만). 본문 { name?, representative?, businessNumber?(000-00-00000), address?, phone? }(보낸 칸만, ""이면 비움).
// 모든 칸이 차기 전에는 가입 승인·반려 메일을 보내지 않는다. 200 { changed, info } · 400 invalid_field(+field) · 403
export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await updatePlatformBusinessInfo(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_BUSINESS_MESSAGES[r.reason], field: r.field }, { status: 400 }));
  return noStore(NextResponse.json({ changed: r.changed, info: r.info }));
});
