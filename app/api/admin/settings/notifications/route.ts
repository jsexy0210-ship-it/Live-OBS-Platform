import { NextResponse } from "next/server";
import { NOTIFICATION_SETTINGS_MESSAGES, readNotificationSettings, updateNotificationSettings } from "../../../../../lib/server/admin/notificationSettings";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 알림 채널 설정(MA-082). 조회는 마스터 관리자 전 역할(조회 전용도 보임).
// → { channels: [{ channel: SLACK|EMAIL|SMS|EXTERNAL_MONITOR, target(표시용), minSeverity(URGENT|WARNING|INFO), includeNight, status: CONNECTED|NOT_CONNECTED|ERROR, lastSentAt, lastError }],
//   routes: 10행 [{ eventKey, label, severity, slack, email, sms, roles(PlatformAdminRole 목록, 빈 목록=전체), nightSuppress, nightSuppressible(긴급은 false), isDefault }],
//   senderProfiles: { alimtalk: { profile, status }, sms: { senderNumber, status }, email: { address, status }, usage: { month, alimtalk, sms, email } }, updatedAt }
// 연결된 채널은 실제 공급자가 있는 이메일뿐이고 슬랙·문자·외부 모니터링은 NOT_CONNECTED(저장·조회만, 발송기 없음).
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await readNotificationSettings(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 바꾸기(최고관리자만, system.manage). 본문 { channels?: { SLACK|EMAIL|SMS|EXTERNAL_MONITOR: { target?, minSeverity?, includeNight? } }, routes?: [{ eventKey, slack, email, sms, roles[], nightSuppress }] }(보낸 것만).
// 200 { changed: { channels, routes }, settings(조회와 같음) }. 400: 긴급 이벤트에 nightSuppress를 켜면 urgent_no_night_suppress, 그 밖은 invalid_*. 로그 추적 admin.notification_settings.update(바뀐 항목 이름만).
export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await updateNotificationSettings(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: NOTIFICATION_SETTINGS_MESSAGES[r.reason] }, { status: 400 }));
  return noStore(NextResponse.json({ changed: r.changed, settings: r.settings }));
});
