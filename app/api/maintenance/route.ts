import { NextResponse } from "next/server";
import { prisma } from "../../../lib/server/db";
import { errorResponse, noStore } from "../../../lib/server/http/route";
import { getPublicMaintenance } from "../../../lib/server/maintenance/service";

// 점검 상태(공개, AU-010 화면·예정 안내 띠). 로그인 없이 본다.
// → { active, scheduled(켜 두었고 시작 전), message, startsAt, endsAt }. 꺼져 있으면 message ""·시각 null.
export async function GET() {
  try {
    return noStore(NextResponse.json(await getPublicMaintenance(prisma)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
