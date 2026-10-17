import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { sendPriceChangeNotices } from "../../../../../../lib/server/billing/priceNoticeSend";
import { writeAudit } from "../../../../../../lib/server/audit/log";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 요금 변경 고지 발송(수동 실행, 최고관리자만 billing.price). 이 요금제의 가장 최근 요금 변경에 대해 기존 구독자에게 메일·파트너스 공지를 보내고 수령 기록을 남긴다.
// 응답 { considered, mailSent, mailBlocked, noticeCreated, completed }. 메일 공급자가 없으면(운영에서 연결 전) 메일은 보내지도 기록하지도 않는다. 자동 스케줄은 없다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ code: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.price");
  const { code } = await params;
  const planCode = code.slice(0, 50);
  const r = await sendPriceChangeNotices(prisma, { planCode });
  const meta = requestMeta(req);
  await writeAudit(prisma, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.plan.price_notice_send", targetType: "SubscriptionPlan", targetId: planCode, after: r, ip: meta.ip, userAgent: meta.userAgent });
  return NextResponse.json(r);
});
