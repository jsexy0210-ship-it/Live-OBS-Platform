import { NextResponse } from "next/server";
import { PLATFORM_BUSINESS_MESSAGES, readPlatformBusinessInfo, updatePlatformBusinessInfo } from "../../../../../lib/server/admin/platformBusinessInfo";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 플랫폼(ONQ) 사업자 정보: 파트너스 가입 안내 메일(승인·반려·보완) 바닥글에 쓴다. 조회는 마스터 관리자 전 역할.
// → { name, representative, businessNumber, mailOrderNumber(통신판매업 신고번호), address, phone(고객센터), email, complete(7칸이 모두 차 있으면 true), updatedAt }
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await readPlatformBusinessInfo(prisma)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 바꾸기(최고관리자만). 본문 { name?, representative?, businessNumber?(000-00-00000), mailOrderNumber?, address?, phone?, email? }(보낸 칸만, ""이면 비움).
// 빈 칸이 있어도 가입 승인·반려 메일은 그대로 보내고 바닥글에서 그 항목만 뺀다(MASTER 결정). 빈 칸은 마스터 홈 「오늘 처리할 일」에 남는다. 200 { changed, info } · 400 invalid_field(+field) · 403
export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await updatePlatformBusinessInfo(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_BUSINESS_MESSAGES[r.reason], field: r.field }, { status: 400 }));
  return noStore(NextResponse.json({ changed: r.changed, info: r.info }));
});
