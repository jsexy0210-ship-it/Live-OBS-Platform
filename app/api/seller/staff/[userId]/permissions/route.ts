import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { updateStaffPermissions } from "../../../../../../lib/server/sellers/staff";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 직원 권한 항목 바꾸기(대표자 전용). 보낸 목록으로 통째로 바꾼다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ userId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const { userId } = await params;
  if (!UUID.test(userId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ permissions: unknown }>(req);
  const r = await updateStaffPermissions(prisma, ctx, { staffUserId: userId, permissions: body.permissions }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  return NextResponse.json(r.value);
});
