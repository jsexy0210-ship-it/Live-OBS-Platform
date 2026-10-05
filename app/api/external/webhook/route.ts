import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { MAX_WEBHOOK_BYTES, externalConfig } from "../../../../lib/server/external/config";
import { ingestWebhook } from "../../../../lib/server/external/webhook";

// 외부 쇼핑몰 웹훅 수신(앱 단위 주소 하나). 서명 검증을 통과한 이벤트만 저장하고, 응답 본문에는 아무 값도 싣지 않는다.
// 이벤트를 주문으로 바꿔 대기열에 올리는 일은 다음 단계(주문 저장 PR)다. 저장만 하고 processedAt은 비워 둔다.
export async function POST(req: Request) {
  const cfg = externalConfig();
  // 서명 검증 전이라 큰 본문은 읽기 전에 끊는다(메모리 부담 방지). 헤더가 없거나 거짓이어도 본문 크기는 ingestWebhook이 다시 본다
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return new NextResponse(null, { status: 413, headers: { "cache-control": "no-store" } });
  const rawBody = await req.text();
  const r = await ingestWebhook(prisma, cfg, { rawBody, signature: req.headers.get(cfg.signatureHeader) });
  return new NextResponse(null, { status: r.status === 200 ? 200 : r.status, headers: { "cache-control": "no-store" } });
}
