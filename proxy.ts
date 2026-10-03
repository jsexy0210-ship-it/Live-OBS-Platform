import { NextResponse, type NextRequest } from "next/server";
import { allowedRequestHost } from "./lib/infra/host-policy";

// obs-test Compose에서 명시적으로 켠다. 개발/기존 테스트 환경 설정은 유지한다.
// 인증·권한·CSRF 검증을 대체하지 않으며 X-Forwarded-Host로 우회하지 않는다.
export function proxy(request: NextRequest) {
  if (process.env.OBS_ENFORCE_HOST_POLICY !== "1") return NextResponse.next();
  if (!allowedRequestHost(request.headers.get("host"), request.nextUrl.pathname,
      request.method, process.env.OBS_ALLOWED_HOSTS)) {
    return new NextResponse("요청한 주소로 접속할 수 없습니다.", {
      status: 421,
      headers: { "cache-control": "no-store" },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
