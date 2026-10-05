import { NextResponse } from "next/server";
import { opsMonitor } from "../../../../../lib/server/admin/ops";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 실시간 감시(MA-100, 조회만, 마스터 관리자 전 역할). 실제로 재는 값만 준다(웹훅은 not_measured).
// { at, servers: { total, healthy, stale, noSignal }, jobs: [{ job, lastRunAt, lastStatus, lastOkAt, instances, healthy, lastError?(최고관리자만) }],
//   queue: { automationQueued, oldestQueuedAt }, paymentChecks: [{ kind, pending, oldestAt }], webhooks: "not_measured",
//   autoActions: [{ id, action, targetType, targetId, sellerId, createdAt }], incidents: [{ source, key, severity, message, occurredAt }] }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await opsMonitor(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
