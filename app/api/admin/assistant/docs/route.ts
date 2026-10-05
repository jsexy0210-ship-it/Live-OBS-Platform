import { NextResponse } from "next/server";
import { ADMIN_ASSISTANT_MESSAGES, createAssistantDoc, listAssistantDocs } from "../../../../../lib/server/assistant/admin";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 답변 자료 목록(MA-055). 모든 역할.
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return NextResponse.json(await listAssistantDocs(prisma), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 자료 만들기. 최고관리자·CS. 본문 { title, body, published? }. 공개 자료만 넣는다.
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.manage");
  const r = await createAssistantDoc(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: ADMIN_ASSISTANT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ doc: r.doc }, { status: 201 });
});
