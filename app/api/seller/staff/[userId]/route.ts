import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { updateStaffProfile } from "../../../../../lib/server/sellers/staff";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 직원 이름·휴대폰 고치기(대표자 전용). 본문 { name?, phone? }(보낸 칸만, phone null·""이면 지움).
// 휴대폰 번호가 바뀌면 직원 본인확인 연결이 풀린다(응답 identityLinked: false). 형식이 틀리면 400 invalid_phone·bad_request.
export const PATCH = mutation(async (req: Request, { params }: { params: Promise<{ userId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const { userId } = await params;
  if (!UUID.test(userId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ name?: unknown; phone?: unknown }>(req);
  const r = await updateStaffProfile(prisma, ctx, { staffUserId: userId, name: body.name, phone: body.phone }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  return NextResponse.json(r.value);
});
