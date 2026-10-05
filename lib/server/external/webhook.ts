import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { sellerAccessFor } from "../billing/subscription";
import { MAX_WEBHOOK_BYTES, type ExternalConfig } from "./config";
import { isShopKey } from "./provider";

// 외부 쇼핑몰 웹훅 수신. 순서: 설정 → 크기 → 인증키 검증(X-API-Key 헤더) → 몰 식별 → 연결됨·구독 정상일 때만 저장.
// 공식 문서(WebHook 안내 「인증방식」): 서명 계산 없이 개발자센터 WebHook 인증정보가 X-API-Key 헤더로 그대로 온다. 없거나 틀리면 아무것도 저장하지 않고 401.
// 같은 본문 재전송은 한 번만 저장(eventKey = 본문 해시).
export type IngestResult =
  | { status: 200; stored: boolean }
  | { status: 401 | 400 | 404 | 413 | 503 };

// 길이가 달라도 시간 차이가 없게 해시끼리 비교한다
function verify(expected: string, given: string | null): boolean {
  if (!expected || !given) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(given.trim(), "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function ingestWebhook(db: PrismaClient, cfg: ExternalConfig, input: { rawBody: string; apiKey: string | null }): Promise<IngestResult> {
  if (!cfg.enabled || !cfg.webhookKey) return { status: 503 };
  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_WEBHOOK_BYTES) return { status: 413 };
  if (!verify(cfg.webhookKey, input.apiKey)) return { status: 401 };
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400 };
  }
  const p = payload as { resource?: { mall_id?: unknown }; mall_id?: unknown } | null;
  const shopKey = p?.resource?.mall_id ?? p?.mall_id;
  if (!isShopKey(shopKey)) return { status: 400 };
  // 연결됨 상태만 받는다(해제 대기·다시 연결 필요·해제됨은 주문 수신 0건)
  const conn = await db.externalShopConnection.findFirst({ where: { shopKey, status: "CONNECTED" }, select: { id: true, sellerId: true } });
  if (!conn) return { status: 404 };
  // 결제 유예가 끝나 잠금이면 새 이벤트를 저장하지 않는다(쇼핑몰이 재시도 폭주하지 않게 200)
  if ((await sellerAccessFor(db, conn.sellerId)) === "expired") return { status: 200, stored: false };
  const eventKey = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  const r = await db.externalWebhookEvent.createMany({ data: [{ sellerId: conn.sellerId, connectionId: conn.id, eventKey, payload: payload as object }], skipDuplicates: true });
  await db.externalShopConnection.update({ where: { id: conn.id }, data: { lastEventAt: new Date() } });
  return { status: 200, stored: r.count === 1 };
}
