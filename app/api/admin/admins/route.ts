import { NextResponse } from "next/server";
import { createAdmin, listAdmins } from "../../../../lib/server/admin/accounts";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";

// 마스터 관리자 계정 목록(MA-061)·추가(MA-062). 최고관리자(admin.manage)만.
// GET → { admins: [{ id, email, name, role, status, lastLoginAt, createdAt }] }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "admin.manage");
    return NextResponse.json({ admins: await listAdmins(prisma, admin) });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST { email, name(1~50자), role(SUPER_ADMIN·OPERATIONS·CS·READ_ONLY), password(8자 이상) } → 201 { admin }.
// 400 invalid_input·weak_password, 409 email_taken. 비밀번호는 응답·로그 추적에 남기지 않는다.
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "admin.manage");
  const body = await readJson<{ email: unknown; name: unknown; role: unknown; password: unknown }>(req);
  const r = await createAdmin(prisma, admin, body, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "email_taken" ? 409 : 400 });
  return NextResponse.json({ admin: r.admin }, { status: 201 });
});
