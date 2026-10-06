import { Prisma, type PrismaClient } from "@prisma/client";
import { captureDebit, releaseDebit, reserveDebit } from "../messaging/balance";
import { completeDeliveryByCarrier } from "./delivery";
import { dbClock } from "./overdue";
import type { DeliveryTrackingProvider } from "./trackingProvider";

// 배송 자동조회(판매자 주문 설정 autoTrackingEnabled, 기본 꺼짐). 켠 판매자의 배송 중 주문만 택배사에 조회하고, 조회 건당 발송·이용 충전금(DELIVERY_TRACKING 단가)을 차감한다.
// - 끄면 조회도 차감도 없다(택배사 조회 링크가 기본). 조회 업체가 연결되지 않았거나(provider 없음) 충전 기능이 꺼져 있으면 아무것도 하지 않는다.
// - 차감은 조회 전에 잡고(reserveDebit, 키 tracking:{배송 id}:{조회 구간}) 조회가 성공하면 확정, 실패하면 되돌린다. 같은 구간에서 여러 번 돌려도 한 번만 차감한다.
// - 잔액이 모자라면 그 조회만 건너뛰고(주문·배송 상태는 그대로, 주문 처리 계속) 다음 구간(6시간 뒤)에 다시 시도한다. 충전하면 자동으로 이어진다.
// - 배송 완료로 조회되면 판매자 직접 처리와 같은 경로로 배송 완료(completeDeliveryByCarrier, 감사 order.carrier_deliver)로 바꾼다.
// - 한 번 조회할 때마다 Shipment.trackingCheckedAt을 먼저 선점해(여러 작업자가 같은 건을 두 번 조회하지 않게) 조회 간격을 지킨다.
// 정기 실행(cron) 연결은 인프라 승인 대기라 함수만 둔다.
export const TRACKING_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const TRACKING_LOOKUP_TIMEOUT_MS = 15_000;

type Candidate = { id: string; orderId: string; sellerId: string; courier: string; trackingNumber: string };
export type TrackingRunResult = { looked: number; delivered: number; skippedNoBalance: number; skippedChargingOff: number; failed: number };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("lookup_timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export async function runDeliveryTrackingLookups(
  db: PrismaClient,
  provider: DeliveryTrackingProvider | null,
  opts: { now?: Date; limit?: number; intervalMs?: number; timeoutMs?: number } = {},
): Promise<TrackingRunResult> {
  const result: TrackingRunResult = { looked: 0, delivered: 0, skippedNoBalance: 0, skippedChargingOff: 0, failed: 0 };
  if (!provider) return result;
  const now = opts.now ?? (await dbClock(db));
  const interval = opts.intervalMs ?? TRACKING_INTERVAL_MS;
  const cutoff = new Date(now.getTime() - interval);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const slot = Math.floor(now.getTime() / interval);
  const candidates = await db.$queryRaw<Candidate[]>`
    SELECT s."id", s."orderId", s."sellerId", s."courier", s."trackingNumber" FROM "Shipment" s
    JOIN "Order" o ON o."id" = s."orderId"
    JOIN "SellerOrderPolicy" p ON p."sellerId" = s."sellerId"
    WHERE s."status" = 'IN_TRANSIT' AND o."status" = 'PAID' AND p."autoTrackingEnabled"
      AND (s."trackingCheckedAt" IS NULL OR s."trackingCheckedAt" <= ${cutoff})
    ORDER BY s."trackingCheckedAt" ASC NULLS FIRST, s."id" ASC
    LIMIT ${limit}`;
  for (const s of candidates) {
    try {
      // 선점: 다른 작업자가 먼저 잡았거나 그사이 배송 완료·간격 안이면 건너뛴다
      const claimed = await db.$executeRaw`
        UPDATE "Shipment" SET "trackingCheckedAt" = ${now}
        WHERE "id" = ${s.id}::uuid AND "status" = 'IN_TRANSIT' AND ("trackingCheckedAt" IS NULL OR "trackingCheckedAt" <= ${cutoff})`;
      if (claimed !== 1) continue;
      // 선점한 뒤 설정을 다시 확인한다(그사이 끈 판매자는 차감하지 않는다)
      const on = await db.sellerOrderPolicy.findUnique({ where: { sellerId: s.sellerId }, select: { autoTrackingEnabled: true } });
      if (!on?.autoTrackingEnabled) continue;
      const debit = await db.$transaction((tx) => reserveDebit(tx, { sellerId: s.sellerId, channel: "DELIVERY_TRACKING", idempotencyKey: `tracking:${s.id}:${slot}`, now }));
      if (!debit.ok) {
        // 잔액 부족·충전 기능 꺼짐: 조회만 멈추고 주문·배송은 그대로 둔다
        if (debit.reason === "insufficient_balance") result.skippedNoBalance++;
        else result.skippedChargingOff++;
        continue;
      }
      // 같은 구간의 이전 시도가 이미 조회를 끝냈으면(차감 확정) 다시 조회하지 않는다. 멈춘 시도(차감만 잡힘)는 같은 차감으로 이어서 조회한다.
      if (debit.existing) {
        const prev = await db.sellerMessageLedger.findUnique({ where: { id: debit.ledgerId }, select: { status: true } });
        if (prev?.status === "SUCCEEDED") continue;
      }
      let lookup: Awaited<ReturnType<DeliveryTrackingProvider["lookup"]>>;
      try {
        lookup = await withTimeout(provider.lookup({ courier: s.courier, trackingNumber: s.trackingNumber }), opts.timeoutMs ?? TRACKING_LOOKUP_TIMEOUT_MS);
      } catch {
        lookup = { ok: false, reason: "lookup_error" };
      }
      if (!lookup.ok) {
        await releaseDebit(db, debit.ledgerId);
        result.failed++;
        continue;
      }
      await captureDebit(db, debit.ledgerId);
      result.looked++;
      if (lookup.status === "DELIVERED" && (await completeDeliveryByCarrier(db, s.sellerId, s.orderId)).ok) result.delivered++;
    } catch (e) {
      // 한 건이 실패해도 나머지는 계속한다(이 건은 다음 구간)
      console.error("[delivery_tracking.failed]", s.id, e instanceof Error ? e.message : e);
      result.failed++;
    }
  }
  return result;
}
