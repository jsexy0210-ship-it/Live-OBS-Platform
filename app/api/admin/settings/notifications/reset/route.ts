import { NextResponse } from "next/server";
import { resetNotificationRoutes } from "../../../../../../lib/server/admin/notificationSettings";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 이벤트별 라우팅 기본값 복원(최고관리자만). 바꾼 라우팅을 모두 지운다(채널 설정은 그대로). 200 { reset(지운 수), settings }.
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await resetNotificationRoutes(prisma, admin, requestMeta(req));
  return noStore(NextResponse.json({ reset: r.reset, settings: r.settings }));
});
