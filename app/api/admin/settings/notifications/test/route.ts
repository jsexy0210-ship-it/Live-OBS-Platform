import { NextResponse } from "next/server";
import { NOTIFICATION_SETTINGS_MESSAGES, sendNotificationTest } from "../../../../../../lib/server/admin/notificationSettings";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 테스트 보내기(최고관리자만). 본문 { channels?: ["EMAIL", ...] }(없으면 4채널 모두). 실제로 연결된 채널(이메일)만 보내고 나머지는 NOT_CONNECTED로 알려 준다.
// 200 { results: [{ channel, status: SENT|NOT_CONNECTED|FAILED }], settings }.
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await sendNotificationTest(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: NOTIFICATION_SETTINGS_MESSAGES[r.reason] }, { status: 400 }));
  return noStore(NextResponse.json({ results: r.results, settings: r.settings }));
});
