import type { MaintenanceWindowStatus, Prisma, PrismaClient } from "@prisma/client";

// 점검 예약·이력(MA-083)의 DB 도우미. 권한·검증은 windows.ts, 한 줄짜리 「지금 상태」(PlatformMaintenance)는 프록시가 읽는 사본이다.
type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
export const OPEN_MAX = 20; // 동시에 열어 둘 수 있는 예약·진행 중 점검 수

// 점검 시간과 겹친 방송 수: 시작이 끝 시각 이전이고 점검 시작 뒤에도 이어졌거나 아직 방송 중인 것
export function countAffectedBroadcasts(db: Db, startsAt: Date, until: Date) {
  return db.broadcastSession.count({ where: { startedAt: { lte: until }, OR: [{ endedAt: null }, { endedAt: { gte: startsAt } }] } });
}

// 줄이 없으면 만들고 잠가서 동시 변경을 한 줄로 세운다
export async function lockMirror(tx: Tx) {
  await tx.$executeRaw`INSERT INTO "PlatformMaintenance" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING`;
  await tx.$queryRaw`SELECT "id" FROM "PlatformMaintenance" WHERE "id" = 1 FOR UPDATE`;
}

// 열린(예약·진행 중) 창을 끝내거나 취소한다. 이미 닫힌 창은 건드리지 않는다(동시에 닫아도 한쪽만).
export async function closeWindow(tx: Tx, w: { id: string; startsAt: Date }, status: Extract<MaintenanceWindowStatus, "ENDED" | "CANCELED">, adminId: string, now: Date) {
  const affectedBroadcasts = status === "ENDED" ? await countAffectedBroadcasts(tx, w.startsAt, now) : null;
  const r = await tx.platformMaintenanceWindow.updateMany({ where: { id: w.id, status: "SCHEDULED" }, data: { status, endedAt: now, endedByAdminId: adminId, affectedBroadcasts } });
  return r.count === 1;
}

// 지금 상태 사본을 열린 창 중 시작이 가장 이른 것으로 맞춘다(없으면 꺼짐). 사본이 바뀌면 version을 올린다.
export async function syncMirror(tx: Tx, adminId: string) {
  const first = await tx.platformMaintenanceWindow.findFirst({ where: { status: "SCHEDULED" }, orderBy: [{ startsAt: "asc" }, { id: "asc" }] });
  await tx.platformMaintenance.update({
    where: { id: 1 },
    data: first
      ? { enabled: true, message: first.message, startsAt: first.startsAt, endsAt: first.endsAt, updatedByAdminId: adminId, version: { increment: 1 } }
      : { enabled: false, message: "", startsAt: null, endsAt: null, updatedByAdminId: adminId, version: { increment: 1 } },
  });
}
