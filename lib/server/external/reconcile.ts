import type { PrismaClient } from "@prisma/client";
import { recordExternalCost } from "../automation/budget";
import { sellerAccessFor } from "../billing/subscription";
import { CALL_LIMIT_PER_10_MIN, CALL_SAFETY_RATIO } from "./config";
import { EXTERNAL_PROVIDER } from "./connect";
import { cancelExternalOrder, storeExternalOrder } from "./orders";
import { accessTokenOf, toNormalized, type Api } from "./process";
import { ExternalHttpError, type ExternalOrderData } from "./provider";
import { refreshConnection } from "./jobs";

// 누락 보정(정기 작업): 웹훅은 일부 누락될 수 있어(공식 문서 권고) 최근 결제·취소 주문을 주문 목록 조회로 다시 훑어 빠진 것을 올린다.
// 이미 올라간 주문은 한 번만 저장되므로(같은 연결·같은 외부 주문번호) 몇 번 돌려도 같다. 읽기 권한만 쓴다(웹훅 로그 조회는 별도 권한이라 쓰지 않는다).
// - 결제 주문: 연결한 시각(connectedAt) 이후에 결제됐고 취소 아닌 것만 올린다(연결 전 과거 주문을 한꺼번에 올리지 않는다).
// - 취소 주문: 취소일 기준으로 훑어 이미 올라간 주문이면 대기 항목을 취소한다(없는 주문은 무시).
// 호출 수: 연결당 한 번에 목록 2종 × 최대 MAX_PAGES쪽. 쇼핑몰 호출 한도(10분 3,000건)의 70% 안전선보다 훨씬 낮고, 한 번 돌 때 안전선을 넘기지 않게 상한을 건다.
export const RECONCILE_WINDOW_MS = 24 * 3600_000;
export const PAGE_SIZE = 100;
export const MAX_PAGES = 3;
export const DEFAULT_RECONCILE_BUDGET_MS = 40_000;
const SAFE_CALLS_PER_RUN = Math.floor(CALL_LIMIT_PER_10_MIN * CALL_SAFETY_RATIO);

// KST 날짜(YYYY-MM-DD)
const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

export type ReconcileResult = { connections: number; stored: number; cancelled: number; deferred: number };

export async function reconcileOrders(db: PrismaClient, api: Api | null, opts: { now?: Date; budgetMs?: number } = {}): Promise<ReconcileResult> {
  const out: ReconcileResult = { connections: 0, stored: 0, cancelled: 0, deferred: 0 };
  if (!api) return out;
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? DEFAULT_RECONCILE_BUDGET_MS;
  const conns = await db.externalShopConnection.findMany({ where: { status: "CONNECTED", refreshTokenCipher: { not: null } }, orderBy: { updatedAt: "asc" }, take: 50, select: { id: true, sellerId: true, shopKey: true, connectedAt: true } });
  let calls = 0;
  for (const c of conns) {
    if (Date.now() - started >= budgetMs || calls >= SAFE_CALLS_PER_RUN) {
      out.deferred++;
      continue;
    }
    // 결제 유예가 끝나 잠긴 파트너스는 쇼핑몰 API를 부르지 않는다
    if ((await sellerAccessFor(db, c.sellerId)) === "expired") continue;
    const token = await accessTokenOf(db, api, c.id, c.sellerId, now);
    if (!token) {
      out.deferred++;
      continue;
    }
    out.connections++;
    const windowStart = new Date(Math.max(c.connectedAt.getTime(), now.getTime() - RECONCILE_WINDOW_MS));
    const range = { startDate: kstDay(windowStart), endDate: kstDay(now) };
    try {
      for (const dateType of ["pay_date", "cancel_date"] as const) {
        for (let page = 0; page < MAX_PAGES; page++) {
          const orders: ExternalOrderData[] = await api.listOrders(c.shopKey, token, { ...range, dateType, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
          calls++;
          await recordExternalCost(db, { provider: EXTERNAL_PROVIDER, purpose: "order_reconcile", costWon: 0 });
          for (const o of orders) {
            if (dateType === "pay_date") {
              // 연결 전에 결제된 주문은 올리지 않는다(결제 시각을 모르면 날짜 범위가 이미 연결 이후로 좁혀 있어 올린다)
              if (!o.paid || o.canceled || o.items.length === 0 || (o.paidAt && o.paidAt < c.connectedAt)) continue;
              const r = await storeExternalOrder(db, c.id, toNormalized(o));
              if (r.ok && r.created) out.stored++;
            } else if (o.canceled) {
              const r = await cancelExternalOrder(db, c.id, o.orderId);
              if (r.ok) out.cancelled += r.cancelledItems;
            }
          }
          if (orders.length < PAGE_SIZE) break;
        }
      }
    } catch (e) {
      // 401: 접근 토큰이 이미 무효 → 바로 새로 받아 두고 다음 번에 다시 한다. 그 밖(429·5xx·시간 초과)도 다음 번에 다시 한다
      if (e instanceof ExternalHttpError && e.status === 401) await refreshConnection(db, api, c.id, now, "force");
      out.deferred++;
    }
  }
  return out;
}
