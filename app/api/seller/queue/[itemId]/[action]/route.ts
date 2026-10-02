import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { assertSameOrigin, errorResponse, queueRejectionStatus, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import type { QueueAction } from "../../../../../../lib/server/queue/rules";
import { applyQueueAction } from "../../../../../../lib/server/queue/service";

const ACTIONS: readonly QueueAction[] = ["start", "complete", "revert", "cancel", "timer"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 개봉 시작(start) · 개봉 완료(complete) · 완료 되돌리기(revert) · 취소(cancel) · 타이머(timer)
export async function POST(req: Request, { params }: { params: Promise<{ itemId: string; action: string }> }) {
  try {
    assertSameOrigin(req);
    const { itemId, action } = await params;
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    if (!ACTIONS.includes(action as QueueAction) || !UUID.test(itemId)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const body = await readJson<{ expectedVersion: number; reason: string; timerSeconds: number }>(req);
    const result = await applyQueueAction(prisma, ctx, itemId, action as QueueAction, {
      expectedVersion: Number.isInteger(body.expectedVersion) ? body.expectedVersion : undefined,
      reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined,
      timerSeconds: body.timerSeconds,
    });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: queueRejectionStatus(result.reason) });
    return NextResponse.json({ item: result.value, version: result.version });
  } catch (e) {
    return errorResponse(e);
  }
}
