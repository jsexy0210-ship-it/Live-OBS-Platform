import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { sellerAccessFor } from "../billing/subscription";
import { MAX_WEBHOOK_BYTES, type ExternalConfig } from "./config";
import { isShopKey } from "./provider";

// 외부 쇼핑몰 웹훅 수신. 순서: 설정 → 크기 → 서명 검증(앱 비밀값 HMAC-SHA256, 본문 그대로) → 몰 식별 → 연결됨·구독 정상일 때만 저장.
// 서명이 없거나 틀리면 아무것도 저장하지 않고 401. 같은 본문 재전송은 한 번만 저장(eventKey = 본문 해시).
// 서명 방식(헤더 이름·계산식)은 공식 문서 직접 확인 전 값이다(docs/EXTERNAL_SHOP.md 「미검증」). 틀리면 모든 수신이 401이라 안전하게 실패한다.
export type IngestResult =
  | { status: 200; stored: boolean }
  | { status: 401 | 400 | 404 | 413 | 503 };

export function signatureOf(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function verify(secret: string, body: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(signatureOf(secret, body));
  const b = Buffer.from(given.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function ingestWebhook(db: PrismaClient, cfg: ExternalConfig, input: { rawBody: string; signature: string | null }): Promise<IngestResult> {
  if (!cfg.enabled) return { status: 503 };
  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_WEBHOOK_BYTES) return { status: 413 };
  if (!verify(cfg.clientSecret, input.rawBody, input.signature)) return { status: 401 };
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
