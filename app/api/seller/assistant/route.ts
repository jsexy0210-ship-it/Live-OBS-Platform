import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";
import { ASSISTANT_MESSAGES, askAssistant, assistantAvailability, assistantStatus } from "../../../../lib/server/assistant/service";

// 도우미(SA-140). 파트너스 계정 누구나(직원 포함), 잠김·정지 중에도(사용법 질문만, 비용은 플랫폼 한도·하루 한도가 막는다).
// GET → { available(false면 「준비 중」), questionMax, remainingToday }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return noStore(NextResponse.json(await assistantAvailability(prisma, ctx)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 질문하기. 본문 { question }. 200 { answered, answer, remainingToday }(답하지 못하면 answered:false + 문의하기 안내 문구)
// 400 invalid_question · 429 daily_limit·budget_exhausted · 503 unavailable·upstream_error
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const r = await askAssistant(prisma, ctx, await readJson(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: ASSISTANT_MESSAGES[r.reason] }, { status: assistantStatus(r.reason) }));
  return noStore(NextResponse.json({ answered: r.answered, answer: r.answer, remainingToday: r.remainingToday }));
});
