import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { listAssignees } from "../../../../../lib/server/platform-inquiries/service";

// 「담당 변경」 선택 목록(MA-051·052). 보기는 마스터 관리자 전 역할. → { items: [{ id, name, role(SUPER_ADMIN|OPERATIONS|CS) }] }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json({ items: await listAssignees(prisma, admin) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
