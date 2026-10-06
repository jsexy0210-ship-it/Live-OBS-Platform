import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { overlayAddressInfo } from "../../../../../lib/server/overlay/access";

// 방송 화면 주소 정보(SA-052). 응답 { issuedAt|null, lastAccessAt|null, lastClient|null("OBS"·"Chrome" 등), connected(지금 연결 중), openSources(열린 소스 수),
// live(방송 중 → 재발급 불가), accesses: 최근 20건 [{ at, client("OBS 30.1 · Windows"), layout("9x16"|"16x9"|null), state("connected"|"ended"|"unknown_browser") }],
// reissues: 최근 20건 [{ at, by(발급한 사람 이름|null), kind("first"|"reissue") }] }. 주소(토큰)는 돌려주지 않는다. OVERLAY_EDIT 권한.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json(await overlayAddressInfo(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}
