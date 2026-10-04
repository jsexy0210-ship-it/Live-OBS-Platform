import { NextResponse } from "next/server";
import { permissionTable } from "../../../../lib/server/admin/accounts";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

// 역할별 권한 표(MA-063, 최고관리자만). { roles, permissions: [{ permission, roles }], byRole: { 역할: [권한] } }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "admin.manage");
    return NextResponse.json(permissionTable(admin));
  } catch (e) {
    return errorResponse(e);
  }
}
