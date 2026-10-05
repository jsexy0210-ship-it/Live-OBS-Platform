import { NextResponse } from "next/server";
import { listAuditLogs } from "../../../../lib/server/admin/auditLogs";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

// 로그 추적 목록(MA-070, audit.read: 최고관리자·운영·조회 전용). action(정확히, 또는 「.」으로 끝나면 접두어)·actorType·actorId·sellerId·targetId·
// from·to(KST 날짜)·cursor·limit. 잘못된 값 400. { logs: [{ id, createdAt, actorType, actorId, action, targetType, targetId, reason, ip, seller }], nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "audit.read");
    const p = new URL(req.url).searchParams;
    const keys = ["action", "actorType", "actorId", "sellerId", "targetId", "from", "to", "cursor", "limit"] as const;
    const r = await listAuditLogs(prisma, admin, Object.fromEntries(keys.map((k) => [k, p.get(k)])));
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ logs: r.logs, nextCursor: r.nextCursor });
  } catch (e) {
    return errorResponse(e);
  }
}
