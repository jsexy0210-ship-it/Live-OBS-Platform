import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// DB 상태와 무관한 프로세스 생존 확인. 배포 승인에는 /api/health도 필요하다.
export async function GET() {
  return NextResponse.json(
    { status: "ok", version: process.env.APP_VERSION || null },
    { headers: { "cache-control": "no-store" } },
  );
}
