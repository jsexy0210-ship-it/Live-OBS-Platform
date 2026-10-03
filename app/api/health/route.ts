import { NextResponse } from "next/server";
import { prisma } from "../../../lib/server/db";

// 빌드 때 미리 만들지 않는다(요청마다 DB 연결을 확인).
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

// 앱 기동·DB 연결 확인(배포 워크플로·Compose healthcheck가 쓴다). 공개 경로라 오류 내용·내부 정보는 돌려주지 않는다.
// version은 배포한 커밋 SHA(이미지 빌드 때 APP_VERSION으로 넣음). 없으면 null.
export async function GET() {
  const version = process.env.APP_VERSION || null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "ok", version }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ status: "error", db: "error", version }, { status: 503, headers: NO_STORE });
  }
}
