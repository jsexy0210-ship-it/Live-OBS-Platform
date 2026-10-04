import { NextResponse } from "next/server";
import { updateAdmin } from "../../../../../lib/server/admin/accounts";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 마스터 관리자 계정 수정(MA-062). 최고관리자만. 본문 { name?, role?, status?(ACTIVE·SUSPENDED) }(빼면 그대로).
// 정지하면 그 계정의 세션이 끝난다. 400 invalid_input, 404, 409 last_super_admin(마지막 최고관리자의 역할 변경·정지).
export const PATCH = mutation(async (req: Request, { params }: { params: Promise<{ adminId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "admin.manage");
  const { adminId } = await params;
  if (!UUID.test(adminId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ name: unknown; role: unknown; status: unknown }>(req);
  const r = await updateAdmin(prisma, admin, adminId, body, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : r.reason === "last_super_admin" ? 409 : 400 });
  return NextResponse.json({ admin: r.admin });
});
