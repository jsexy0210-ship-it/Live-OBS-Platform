import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { CONTENT_MESSAGES, setBannerInterval } from "../../../../../../lib/server/shop-content/service";

// 홈 배너 자동 넘김 간격 바꾸기. 본문 { intervalSec: 0 | 5 | 8 }(0=끔). 대표자·「쇼핑몰 설정」 직원만, 플랜 기능 STORE_OPERATIONS.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await setBannerInterval(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: CONTENT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ intervalSec: r.intervalSec });
});
