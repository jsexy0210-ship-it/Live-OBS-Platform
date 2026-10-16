import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { retentionDeletionReport, sendRetentionNotices } from "../../../../lib/server/billing/retentionNotice";
import { writeAudit } from "../../../../lib/server/audit/log";
import { prisma } from "../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../lib/server/http/route";

// 삭제 전 안내 메일 발송(수동 실행, 최고관리자만 billing.price). 보관 기간 종료 전 안내 기간의 해지 쇼핑몰에 대표자 메일 1통.
// 응답 { notices, report }. report는 읽기 전용 삭제 후보 보고(삭제는 하지 않음, `?after=<nextAfterId>&limit=`로 이어 읽음). 자동 스케줄 없음.
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.price");
  const notices = await sendRetentionNotices(prisma);
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit"));
  const report = await retentionDeletionReport(prisma, { afterId: url.searchParams.get("after"), ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}) });
  const meta = requestMeta(req);
  await writeAudit(prisma, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.retention.notice_send", targetType: "Platform", targetId: "retention", after: { ...notices, candidates: report.candidates.length }, ip: meta.ip, userAgent: meta.userAgent });
  return NextResponse.json({ notices, report });
});
