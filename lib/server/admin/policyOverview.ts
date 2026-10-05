import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { getAssistantSettings } from "../assistant/admin";
import { getMaintenance } from "../maintenance/service";
import { getAdminMessageSettings } from "../messaging/settings";
import { listAdminPlans } from "./billing";

// 플랫폼 기본 정책(MA-081): 이미 있는 값(요금제·발송·이용 충전·점검·도우미)을 한 번에 모아 보는 조회. 새 설정·저장은 없다.
// 바꾸기는 section마다 edit에 적은 기존 API로 한다(최고관리자만). 도우미 API 키 같은 비밀값은 내리지 않고 설정 여부만 준다.
export async function getPolicyOverview(db: PrismaClient, admin: AdminSessionContext) {
  const [plans, message, maintenance, assistant] = await Promise.all([
    listAdminPlans(db, admin),
    getAdminMessageSettings(db, admin),
    getMaintenance(db, admin),
    getAssistantSettings(db),
  ]);
  return {
    plans: plans.plans,
    message,
    maintenance,
    assistant: { settings: assistant.settings, keyConfigured: assistant.keyConfigured, available: assistant.available, month: assistant.month, usedMilliWon: assistant.usedMilliWon },
    edit: {
      plans: "/api/admin/plans/{code}/price · trial-limits · mail-quota",
      message: "/api/admin/message-settings · /api/admin/message-prices/{channel}",
      maintenance: "/api/admin/settings/maintenance",
      assistant: "/api/admin/assistant/settings",
    },
  };
}
