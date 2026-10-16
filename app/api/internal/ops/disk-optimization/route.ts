import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { configuredDiskActions } from "../../../../../lib/server/ops/diskOptimizationActions";

// 관측 ingest와 별도 자격이다. 미설정·미승인 실행은 차단한다.
export async function POST(req: Request) {
  const headers = { "cache-control": "no-store" };
  const bridge = configuredDiskActions(prisma);
  if (!bridge) return NextResponse.json({ error: "disk_actions_unavailable" }, { status: 503, headers });
  if (!bridge.authorized(req.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw) > 64 * 1024) return NextResponse.json({ error: "invalid_callback" }, { status: 400, headers });
    return NextResponse.json(await bridge.callback(JSON.parse(raw)), { headers });
  } catch {
    // runner/DB/API 응답이나 자격 값을 본문에 싣지 않는다.
    return NextResponse.json({ error: "disk_actions_callback_rejected" }, { status: 409, headers });
  }
}
