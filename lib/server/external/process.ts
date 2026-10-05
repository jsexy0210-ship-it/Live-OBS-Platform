import type { PrismaClient } from "@prisma/client";
import { recordExternalCost } from "../automation/budget";
import { openBillingKey } from "../billing/secret";
import { sellerAccessFor } from "../billing/subscription";
import { EXTERNAL_PROVIDER } from "./connect";
import { refreshConnection } from "./jobs";
import { ExternalHttpError, type ExternalOrderApi, type ExternalShopProvider } from "./provider";
import { cancelExternalOrder, storeExternalOrder, type NormalizedExternalOrder } from "./orders";
import { cleanText } from "../text/clean";

// 받아 둔 웹훅 이벤트를 주문대기·취소로 옮긴다(processedAt이 빈 것만, 오래된 순). 같은 이벤트를 몇 번 처리해도 결과는 같다
// (주문 저장은 같은 외부 주문번호 한 번만, 취소는 이미 취소여도 그대로).
// 공식 문서 기준(docs/EXTERNAL_SHOP.md): 이벤트에는 주문 머리 정보만 있고 품목 줄이 없어, 주문 조회 API로 줄·결제·취소 여부를 확인한 값으로 처리한다.
//   90023 주문 접수·90025 입금 상태 변경 → 결제 완료이고 취소 아닌 주문만 주문대기에 올림
//   90026 취소·90072 취소(일괄)·90029 환불·90073 환불(일괄) → 조회 결과 주문 전체가 취소(canceled)일 때만 대기 항목 취소(부분 취소는 줄 단위 상태가 문서에서 확인되지 않아 건드리지 않음)
//   그 밖의 이벤트는 처리 대상이 아니라 처리됨으로만 표시
// 일시 오류(429·5xx·시간 초과·접근 토큰 없음)는 처리됨으로 표시하지 않고 다음 번에 다시 한다. 영구 오류(주문 없음·형식 틀림·연결 해제)는 처리됨으로 닫는다.
const PLACE_EVENTS = new Set([90023, 90025]);
const CANCEL_EVENTS = new Set([90026, 90072, 90029, 90073]);
export const MAX_ORDERS_PER_EVENT = 50;
export const DEFAULT_BATCH = 50;
export const DEFAULT_BUDGET_MS = 40_000;

export type ProcessResult = { processed: number; deferred: number };

// 방송 화면에 이름 전체를 보이지 않는다: 첫 글자와 끝 글자만 남기고 가운데를 가린다(두 글자는 뒤 글자만 가림).
export function maskBuyerName(name: string | null): string | null {
  const clean = cleanText(name, 50);
  if (!clean) return null;
  const chars = Array.from(clean);
  if (chars.length === 1) return chars[0];
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(Math.min(chars.length - 2, 5))}${chars[chars.length - 1]}`;
}

function orderIdsOf(payload: unknown): { eventNo: number; ids: string[]; paidHint: string | null } | null {
  const p = payload as { event_no?: unknown; resource?: { order_id?: unknown; paid?: unknown } } | null;
  const eventNo = typeof p?.event_no === "number" ? p.event_no : Number.NaN;
  const raw = p?.resource?.order_id;
  if (!Number.isInteger(eventNo) || typeof raw !== "string") return null;
  const ids = [...new Set(raw.split(",").map((x) => x.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_ORDERS_PER_EVENT || ids.some((i) => !/^[0-9A-Za-z_-]{1,60}$/.test(i))) return null;
  const paid = p?.resource?.paid;
  return { eventNo, ids, paidHint: typeof paid === "string" ? paid : null };
}

const toNormalized = (o: { orderId: string; buyerName: string | null; items: { productName: string; optionValue: string | null; quantity: number }[] }): NormalizedExternalOrder => ({
  externalOrderId: o.orderId,
  buyerLabel: maskBuyerName(o.buyerName),
  lines: o.items.map((i) => ({ productLabel: (i.optionValue ? `${i.productName} (${i.optionValue})` : i.productName).slice(0, 100), quantity: i.quantity })),
});

type Api = ExternalOrderApi & Pick<ExternalShopProvider, "refresh">;

// connectionId를 주면 그 연결의 이벤트만(웹훅 수신 직후), 없으면 전체(정기 작업).
export async function processWebhookEvents(
  db: PrismaClient,
  api: Api | null,
  opts: { connectionId?: string; now?: Date; limit?: number; budgetMs?: number } = {},
): Promise<ProcessResult> {
  if (!api) return { processed: 0, deferred: 0 };
  const now = opts.now ?? new Date();
  const started = Date.now();
  const events = await db.externalWebhookEvent.findMany({
    where: { processedAt: null, ...(opts.connectionId ? { connectionId: opts.connectionId } : {}) },
    orderBy: { receivedAt: "asc" },
    take: opts.limit ?? DEFAULT_BATCH,
    include: { connection: { select: { id: true, sellerId: true, shopKey: true, status: true } } },
  });
  let processed = 0;
  let deferred = 0;
  const done = async (id: string) => {
    await db.externalWebhookEvent.update({ where: { id }, data: { processedAt: new Date() } });
    processed++;
  };
  for (const ev of events) {
    if (Date.now() - started >= (opts.budgetMs ?? DEFAULT_BUDGET_MS)) {
      deferred++;
      continue;
    }
    const conn = ev.connection;
    if (conn.status !== "CONNECTED") {
      await done(ev.id);
      continue;
    }
    const parsed = orderIdsOf(ev.payload);
    const isPlace = !!parsed && PLACE_EVENTS.has(parsed.eventNo);
    const isCancel = !!parsed && CANCEL_EVENTS.has(parsed.eventNo);
    if (!parsed || (!isPlace && !isCancel)) {
      await done(ev.id);
      continue;
    }
    // 아직 입금 전인 접수 이벤트는 조회하지 않는다(입금되면 90025가 온다)
    if (parsed.eventNo === 90023 && parsed.paidHint === "F") {
      await done(ev.id);
      continue;
    }
    // 결제 유예가 끝나 잠긴 파트너스는 쇼핑몰 API를 부르지 않고 닫는다(주문대기에 올리지 않음). 보정 조회가 생겨도 같은 기준이다.
    if ((await sellerAccessFor(db, conn.sellerId)) === "expired") {
      await done(ev.id);
      continue;
    }
    const token = await accessTokenOf(db, api, conn.id, conn.sellerId, now);
    if (!token) {
      deferred++;
      continue;
    }
    try {
      for (const id of parsed.ids) {
        const o = await api.fetchOrder(conn.shopKey, token, id);
        await recordExternalCost(db, { provider: EXTERNAL_PROVIDER, purpose: "order_fetch", costWon: 0 });
        if (!o) continue;
        if (isPlace) {
          if (o.paid && !o.canceled && o.items.length > 0) await storeExternalOrder(db, conn.id, toNormalized(o));
        } else if (o.canceled) {
          await cancelExternalOrder(db, conn.id, o.orderId);
        }
      }
      await done(ev.id);
    } catch (e) {
      // 401: 접근 토큰이 이미 무효 → 바로 새로 받아 두고(갱신까지 무효면 「다시 연결 필요」) 다음 번에 다시 한다. 그 밖(429·5xx·시간 초과)도 다음 번에 다시 한다
      if (e instanceof ExternalHttpError && e.status === 401) await refreshConnection(db, api, conn.id, now, "force");
      deferred++;
    }
  }
  return { processed, deferred };
}

// 접근 토큰(복호화). 곧 만료되거나 없으면 갱신하고, 갱신할 수 없으면 null.
async function accessTokenOf(db: PrismaClient, api: Api, connectionId: string, sellerId: string, now: Date): Promise<string | null> {
  const read = () => db.externalShopConnection.findUnique({ where: { id: connectionId }, select: { status: true, accessTokenCipher: true, accessExpiresAt: true } });
  let c = await read();
  if (!c || c.status !== "CONNECTED") return null;
  if (!c.accessTokenCipher || !c.accessExpiresAt || c.accessExpiresAt.getTime() < now.getTime() + 60_000) {
    await refreshConnection(db, api, connectionId, now, "inline");
    c = await read();
    if (!c || c.status !== "CONNECTED" || !c.accessTokenCipher || !c.accessExpiresAt || c.accessExpiresAt.getTime() < now.getTime() + 60_000) return null;
  }
  return openBillingKey(c.accessTokenCipher, sellerId);
}
