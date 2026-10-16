import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { createWindow, listWindows, WINDOW_MESSAGES } from "../../../../../../lib/server/maintenance/windows";

// 점검 예약·이력(MA-083). 보기는 마스터 관리자 전 역할. 쿼리 cursor·limit(이력, 기본 20, 최대 100).
// → { upcoming: [{ id, phase(SCHEDULED·ACTIVE), kind, startsAt, plannedEndsAt, message, reason, createdByName }], live: { broadcasts, waitingOrders },
//     history: [{ …, phase(ENDED·CANCELED), endedAt, endedByName, affectedBroadcasts }], nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await listWindows(prisma, admin, { cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return noStore(NextResponse.json({ error: "bad_request", message: WINDOW_MESSAGES.bad_request }, { status: 400 }));
    const { ok: _ok, ...body } = r;
    return noStore(NextResponse.json(body));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 예약·즉시 켜기(최고관리자만). 본문 { message(필수 500자), reason(필수 200자), startsAt?(ISO, 지금보다 뒤, 없으면 즉시), endsAt?(ISO, 안내용) }.
// 201 { window } · 400 invalid_message·reason_required·invalid_time · 409 already_active·too_many. 방송은 자동으로 끝나지 않는다.
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await createWindow(prisma, admin, await readJson(req), requestMeta(req));
  if (r.ok) return noStore(NextResponse.json({ window: r.window }, { status: 201 }));
  return noStore(NextResponse.json({ error: r.reason, message: WINDOW_MESSAGES[r.reason] }, { status: r.reason === "already_active" || r.reason === "too_many" ? 409 : 400 }));
});
