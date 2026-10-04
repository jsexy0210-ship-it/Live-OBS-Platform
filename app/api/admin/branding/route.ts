import { NextResponse } from "next/server";
import { readBrandingSettings } from "../../../../lib/server/branding/service";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

// 사이트 설정 > 파비콘·공유 카드: 마스터 관리자·파트너스 관리자 화면의 현재 값. 마스터 관리자 누구나 보고, canEdit은 최고관리자만 true.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await readBrandingSettings(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
