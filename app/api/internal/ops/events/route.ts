import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { readJson } from "../../../../../lib/server/http/route";
import { checkIngestToken, ingestOpsEvents, parseOpsEvents } from "../../../../../lib/server/ops/metrics";

const NO_STORE = { "cache-control": "no-store" };

// 인프라 감시 수집기(scripts/ops/monitor.mjs) 전용 사건 기록. 브라우저용이 아니라 Origin 검사 대신 내부 토큰으로 인증한다:
// Authorization: Bearer <OPS_INGEST_TOKEN>(서버 환경변수, 32자 이상, 없으면 503 disabled). 틀리면 401.
// 본문 { events: [{ source, eventId, kind: incident_open|incident_close|info|warning, key, severity?: info|warning|critical, message, detail?, occurredAt }] }(최대 50건).
// 같은 (source, eventId)는 한 번만 저장한다(재전송 안전). 200 { stored }. occurredAt이 받은 시각보다 5분 넘게 미래면 전체를 400으로 거부한다.
// 열림·닫힘 상태는 서버가 받은 순서로 정한다(occurredAt은 표시용).
export async function POST(req: Request) {
  const auth = checkIngestToken(req.headers.get("authorization"));
  if (auth === "disabled") return NextResponse.json({ error: "ingest_disabled" }, { status: 503, headers: NO_STORE });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const events = parseOpsEvents(await readJson(req));
  if (!events) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  return NextResponse.json({ stored: await ingestOpsEvents(prisma, events) }, { headers: NO_STORE });
}
