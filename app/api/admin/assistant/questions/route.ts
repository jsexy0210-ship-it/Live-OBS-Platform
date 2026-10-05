import { NextResponse } from "next/server";
import { ADMIN_ASSISTANT_MESSAGES, listAssistantQuestions } from "../../../../../lib/server/assistant/admin";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";

// 질문 기록(MA-055). 모든 역할. ?unanswered=1 → 답하지 못한 질문만. ?cursor=
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const u = new URL(req.url).searchParams;
    const r = await listAssistantQuestions(prisma, { cursor: u.get("cursor"), unanswered: u.get("unanswered") === "1" });
    if (!r.ok) return NextResponse.json({ error: r.reason, message: ADMIN_ASSISTANT_MESSAGES[r.reason] }, { status: 400 });
    return NextResponse.json({ items: r.items, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
