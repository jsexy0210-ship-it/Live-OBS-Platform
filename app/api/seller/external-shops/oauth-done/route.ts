import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { completeConnect } from "../../../../../lib/server/external/connect";
import { externalProvider } from "../../../../../lib/server/external/provider";
import { sessionToken } from "../../../../../lib/server/http/route";

// 인증 뒤 돌아오는 주소(브라우저 이동). 시작한 같은 파트너스·직원 세션과 1회용 state가 맞을 때만 연결하고,
// 결과는 SA-006으로 돌려보낸다(?connected=1 또는 ?error=코드). 코드·state·토큰은 주소에 남기지 않는다.
const SCREEN = "/seller/external-shops";
const go = (q: string) => new Response(null, { status: 303, headers: { location: `${SCREEN}?${q}`, "cache-control": "no-store" } });

export async function GET(req: Request) {
  const url = new URL(req.url);
  let ctx;
  try {
    ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "EXTERNAL_INTEGRATION" });
  } catch {
    return go("error=login_required");
  }
  if (url.searchParams.get("error")) return go("error=denied");
  try {
    const r = await completeConnect(prisma, externalProvider(), ctx, { state: url.searchParams.get("state"), code: url.searchParams.get("code") });
    return r.ok ? go("connected=1") : go(`error=${r.reason}`);
  } catch {
    return go("error=forbidden");
  }
}
