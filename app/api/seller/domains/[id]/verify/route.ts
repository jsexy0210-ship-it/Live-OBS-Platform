import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { DOMAIN_MESSAGES, DOMAIN_STATUS, verifyDomain } from "../../../../../../lib/server/seller-settings/domains";

// 소유 확인(SHOP_SETTINGS). 도메인 DNS의 _onq-verify TXT 값을 조회해 맞으면 확인 처리한다. 응답: { verified: boolean, domain }.
// 아직 맞지 않으면 200 verified:false(바뀌는 것 없음). 도메인마다 15초에 한 번만(429 verify_too_soon), 이미 확인된 도메인은 409 already_verified.
export const POST = mutation(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const t = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { id } = await ctx.params;
  const r = await verifyDomain(prisma, t, id, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: DOMAIN_MESSAGES[r.reason] }, { status: DOMAIN_STATUS[r.reason] });
  return NextResponse.json({ verified: r.verified, domain: r.domain });
});
