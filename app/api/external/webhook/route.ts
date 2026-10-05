import { NextResponse, after } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { MAX_WEBHOOK_BYTES, externalConfig } from "../../../../lib/server/external/config";
import { processWebhookEvents } from "../../../../lib/server/external/process";
import { externalProvider } from "../../../../lib/server/external/provider";
import { ingestWebhook } from "../../../../lib/server/external/webhook";

// 외부 쇼핑몰 웹훅 수신(앱 단위 주소 하나). 서명 검증을 통과한 이벤트만 저장하고, 응답 본문에는 아무 값도 싣지 않는다.
// 저장한 뒤 응답을 먼저 보내고, 이어서 이벤트를 주문대기·취소로 옮긴다(process.ts). 실패하거나 못 한 이벤트는 정기 작업이 다시 처리한다.
export async function POST(req: Request) {
  const cfg = externalConfig();
  // 서명 검증 전이라 큰 본문은 읽기 전에 끊는다(메모리 부담 방지). 헤더가 없거나 거짓이어도 본문 크기는 ingestWebhook이 다시 본다
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return new NextResponse(null, { status: 413, headers: { "cache-control": "no-store" } });
  const rawBody = await req.text();
  const r = await ingestWebhook(prisma, cfg, { rawBody, apiKey: req.headers.get("x-api-key") });
  if (r.status === 200 && r.stored) {
    try {
      after(() => processWebhookEvents(prisma, externalProvider(), { limit: 20, budgetMs: 25_000 }).then(() => undefined, () => undefined));
    } catch {
      // 요청 밖에서 불러 예약하지 못해도 이벤트는 저장돼 있다. 정기 작업이 처리한다.
    }
  }
  return new NextResponse(null, { status: r.status === 200 ? 200 : r.status, headers: { "cache-control": "no-store" } });
}
