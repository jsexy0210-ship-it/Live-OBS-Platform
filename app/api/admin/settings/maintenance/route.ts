import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { getMaintenance, MAINTENANCE_MESSAGES, updateMaintenance } from "../../../../../lib/server/maintenance/service";

// 점검 모드(MA-083). 보기는 마스터 관리자 전 역할.
// → { maintenance: { active, scheduled, enabled, message, startsAt, endsAt, version, updatedAt, updatedByAdminName } }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json({ maintenance: await getMaintenance(prisma, admin) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 바꾸기(최고관리자만). 본문 { enabled, message(켜려면 필수, 500자), startsAt?(ISO, 없으면 바로), endsAt?(ISO, 안내용), expectedVersion }.
// 200 { maintenance } · 400 invalid_message·invalid_time · 409 version_conflict(+currentVersion)
export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await updateMaintenance(prisma, admin, await readJson(req), requestMeta(req));
  if (r.ok) return noStore(NextResponse.json({ maintenance: r.maintenance }));
  const extra = r.reason === "version_conflict" ? { currentVersion: r.currentVersion } : {};
  return noStore(NextResponse.json({ error: r.reason, message: MAINTENANCE_MESSAGES[r.reason], ...extra }, { status: r.reason === "version_conflict" ? 409 : 400 }));
});
