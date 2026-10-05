import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { sellerAccessFor } from "../billing/subscription";
import { MAX_WEBHOOK_BYTES, type ExternalConfig } from "./config";
import { isShopKey } from "./provider";

// 외부 쇼핑몰 웹훅 수신. 순서: 설정 → 크기 → 인증키 검증(X-API-Key 헤더) → 몰 식별 → 연결됨·구독 정상일 때만 저장.
// 공식 문서(WebHook 안내 「인증방식」): 서명 계산 없이 개발자센터 WebHook 인증정보가 X-API-Key 헤더로 그대로 온다. 없거나 틀리면 아무것도 저장하지 않고 401.
// 같은 본문 재전송은 한 번만 저장(eventKey = 본문 해시). 인증을 통과한 요청은 연결 안 된 몰이라도 200(저장 안 함)이다(쇼핑몰의 실패율 집계로 수신이 꺼지지 않게).
export type IngestResult =
  | { status: 200; stored: boolean; ignored?: "unknown_shop" }
  | { status: 401 | 400 | 413 | 503 };

// 공식 문서의 헤더는 `X-API-Key: <WebHook 인증정보>` 그대로다(헤더 이름은 대소문자 무관). 값은 앞뒤 공백·감싼 따옴표·「Bearer 」 접두어를 떼고 비교한다
// (환경변수에 따옴표째 붙여 넣은 경우 등). 값 자체의 대소문자는 구분한다.
export function normalizeKey(v: string): string {
  let k = v.trim();
  if (k.length >= 2 && /^(["'])[\s\S]*\1$/.test(k)) k = k.slice(1, -1).trim();
  return k.replace(/^Bearer\s+/i, "").trim();
}

// 길이가 달라도 시간 차이가 없게 해시끼리 비교한다
function verify(expected: string, given: string | null): boolean {
  const e = normalizeKey(expected);
  const g = given === null ? "" : normalizeKey(given);
  if (!e || !g) return false;
  const a = createHash("sha256").update(e, "utf8").digest();
  const b = createHash("sha256").update(g, "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function ingestWebhook(db: PrismaClient, cfg: ExternalConfig, input: { rawBody: string; apiKey: string | null }): Promise<IngestResult> {
  if (!cfg.enabled || !cfg.webhookKey) return { status: 503 };
  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_WEBHOOK_BYTES) return { status: 413 };
  if (!verify(cfg.webhookKey, input.apiKey)) {
    // 값은 남기지 않는다(헤더가 왔는지와 길이만): 쇼핑몰 화면의 인증정보와 서버 값이 다를 때 원인을 좁히는 용도
    console.warn("external_webhook_auth_failed", { hasHeader: input.apiKey !== null, givenLength: input.apiKey?.trim().length ?? 0, expectedLength: cfg.webhookKey.length });
    return { status: 401 };
  }
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
  // 연결되지 않은 몰(해제됐거나 샘플·테스트 전송)도 인증을 통과했으면 200으로 답한다. 쇼핑몰은 2xx가 아니면 실패로 세고 실패율이 높으면 수신을 자동으로 끄기 때문이다. 저장하지 않는다.
  if (!conn) return { status: 200, stored: false, ignored: "unknown_shop" };
  // 결제 유예가 끝나 잠금이면 새 이벤트를 저장하지 않는다(쇼핑몰이 재시도 폭주하지 않게 200)
  if ((await sellerAccessFor(db, conn.sellerId)) === "expired") return { status: 200, stored: false };
  const eventKey = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  const r = await db.externalWebhookEvent.createMany({ data: [{ sellerId: conn.sellerId, connectionId: conn.id, eventKey, payload: payload as object }], skipDuplicates: true });
  await db.externalShopConnection.update({ where: { id: conn.id }, data: { lastEventAt: new Date() } });
  return { status: 200, stored: r.count === 1 };
}
