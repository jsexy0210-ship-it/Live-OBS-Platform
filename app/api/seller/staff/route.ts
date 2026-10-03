import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, isString, mutation, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { createStaff, listStaff } from "../../../../lib/server/sellers/staff";

// 직원 목록(대표자 전용)
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    return NextResponse.json({ staff: await listStaff(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}

// 직원 계정 만들기(대표자 전용): 이메일·이름·초기 비밀번호·권한 항목·휴대폰(선택, 형식이 틀리면 400 invalid_phone)
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const body = await readJson<{ email: string; name: string; password: string; permissions: unknown; phone?: unknown }>(req);
  if (!isString(body.email) || !isString(body.name) || !isString(body.password)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const r = await createStaff(
    prisma,
    ctx,
    { email: body.email, name: body.name, password: body.password, permissions: body.permissions, phone: body.phone },
    requestMeta(req),
  );
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "email_taken" ? 409 : 400 });
  return NextResponse.json(r.value, { status: 201 });
});
