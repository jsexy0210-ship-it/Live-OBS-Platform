import { NextResponse, type NextRequest } from "next/server";
import { IMPERSONATION_COOKIE, impersonationRequestAllowed } from "./lib/server/auth/impersonation";
import { prisma } from "./lib/server/db";
import { cachedMaintenance, isActive, maintenanceTarget, maintenanceNotice } from "./lib/server/maintenance/service";

// 점검 모드(MA-083 · AU-010). 점검 중이면 파트너스·구매자·가입 API는 503 maintenance, /seller·/shop 화면은 /maintenance로 보여 준다(주소는 그대로).
// 막는 경로 목록은 lib/server/maintenance/service.ts maintenanceTarget 한 곳. 상태는 서버마다 5초 기억하고, DB를 못 읽으면 막지 않는다.
export async function proxy(req: NextRequest) {
  // 마스터 대리 조회(MA-016) 쿠키가 붙은 파트너스 API 요청은 조회 허용 경로의 GET·HEAD만 통과한다(나머지는 403, 경로를 하나씩 믿지 않는 안전망)
  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/seller/") && req.cookies.has(IMPERSONATION_COOKIE) && !impersonationRequestAllowed(req.method, path)) {
    return NextResponse.json({ error: "impersonation_read_only" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const target = maintenanceTarget(req.nextUrl.pathname);
  if (!target) return NextResponse.next();
  const m = await cachedMaintenance(prisma);
  if (!m || !isActive(m)) return NextResponse.next();
  if (target === "api") {
    return NextResponse.json(
      { error: "maintenance", message: m.message || maintenanceNotice(req.nextUrl.pathname), endsAt: m.endsAt },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "300" } },
    );
  }
  return NextResponse.rewrite(new URL("/maintenance", req.url));
}

export const config = {
  matcher: ["/api/seller/:path*", "/api/seller-signup/:path*", "/api/shop/:path*", "/api/automation/purchase", "/api/automation/reconnect", "/seller/:path*", "/shop/:path*"],
};
