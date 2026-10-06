import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { endBroadcast } from "../queue/service";
import type { TenantContext } from "../tenant/context";

// 마스터 관리자 방송 강제 종료(MA-041): 파트너스가 끝내지 못하는 LIVE 방송(PC 꺼짐·개봉 중 잔존 등)을 끝낸다. 운영·최고관리자(seller.moderate)만, 사유 필수(1~200자).
// 개봉 중 항목은 그대로 두어(파트너스가 완료·취소) 주문 처리 결과를 바꾸지 않고, 남은 대기는 다음 방송으로 이월한다. 로그 추적 broadcast.force_end.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function forceEndBroadcast(db: PrismaClient, admin: AdminSessionContext, broadcastId: string, rawReason: unknown) {
  if (!adminCan(admin.admin.role, "seller.moderate")) throw forbidden();
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (reason.length < 1 || reason.length > 200) return { ok: false as const, reason: "reason_required" as const };
  if (!UUID.test(broadcastId)) return { ok: false as const, reason: "not_found" as const };
  const session = await db.broadcastSession.findUnique({ where: { id: broadcastId }, select: { id: true, sellerId: true, status: true } });
  if (!session) return { ok: false as const, reason: "not_found" as const };
  if (session.status !== "LIVE") return { ok: false as const, reason: "not_live" as const };
  const ctx: TenantContext = { sellerId: session.sellerId, actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, isOwner: true, permissions: [], readOnly: false };
  const r = await endBroadcast(db, ctx, { broadcastSessionId: session.id, force: true, audit: "broadcast.force_end", reason });
  if (!r.ok) return { ok: false as const, reason: r.reason === "not_live" ? ("not_live" as const) : ("not_found" as const) };
  return { ok: true as const, broadcastId: r.value.broadcastSessionId, carriedOver: r.value.carriedOver };
}
