import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { DOMAIN_MESSAGES, DOMAIN_STATUS, createDomain, listDomains } from "../../../../lib/server/seller-settings/domains";

// 쇼핑몰 도메인 연결(SA-060, SHOP_SETTINGS). 서버는 등록·DNS 안내·소유 확인(DNS 조회)·해제·상태 표시까지만 한다(DNS 설정·인증서 발급은 하지 않음).
// GET 응답: { domains: [{ id, hostname, status: PENDING_VERIFICATION | VERIFIED | SUSPENDED, verifiedAt, certStatus, expiresAt, dns: { verify: TXT, connect: CNAME } }], limit, targets }
// POST 본문 { hostname }: 소문자 호스트 이름, 쇼핑몰마다 3개까지. 오류 코드는 응답 error(invalid_domain·reserved_domain 400, domain_taken·too_many_domains 409).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json(await listDomains(prisma, ctx), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await createDomain(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: DOMAIN_MESSAGES[r.reason] }, { status: DOMAIN_STATUS[r.reason] });
  return NextResponse.json({ domain: r.domain }, { status: 201 });
});
