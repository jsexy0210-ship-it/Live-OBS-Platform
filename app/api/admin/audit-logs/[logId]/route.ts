import { NextResponse } from "next/server";
import { getAuditLog } from "../../../../../lib/server/admin/auditLogs";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 로그 추적 상세(MA-071): 목록 항목 + before·after·userAgent, 관리자 행위자면 이름·이메일·역할. 없으면 404.
export async function GET(req: Request, { params }: { params: Promise<{ logId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "audit.read");
    const { logId } = await params;
    const log = UUID.test(logId) ? await getAuditLog(prisma, admin, logId) : null;
    if (!log) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ log });
  } catch (e) {
    return errorResponse(e);
  }
}
