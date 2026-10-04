import { NextResponse } from "next/server";
import { prisma } from "../../../lib/server/db";
import { isTestMode } from "../../../lib/server/testMode";

// 빌드 때 미리 만들지 않는다(요청마다 DB 연결을 확인).
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

// 앱 기동·DB 연결 확인(배포 워크플로·Compose healthcheck가 쓴다). 공개 경로라 오류 내용·내부 정보는 돌려주지 않는다.
// version은 배포한 커밋 SHA(이미지 빌드 때 APP_VERSION으로 넣음). 없으면 null.
// 테스트 서버 모드(OBS_TEST_MODE=1)면 testMode: true를 붙인다(화면이 「테스트 모드예요 · 인증번호 000000」 안내에 쓰는 공개 값).
export async function GET() {
  const version = process.env.APP_VERSION || null;
  const mode = isTestMode() ? { testMode: true } : {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "ok", version, ...mode }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ status: "error", db: "error", version, ...mode }, { status: 503, headers: NO_STORE });
  }
}
