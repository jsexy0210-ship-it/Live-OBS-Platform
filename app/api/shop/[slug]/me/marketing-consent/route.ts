import { NextResponse } from "next/server";
import { MARKETING_CONSENT_MESSAGES, MARKETING_CONSENT_STATUS, readMarketingConsent, setMarketingConsent } from "../../../../../../lib/server/buyers/marketingConsent";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";

// 구매자 본인의 마케팅 정보 수신 동의(로그인한 쇼핑몰 회원만, 잠긴 쇼핑몰이어도 철회는 연다).
// GET → { agreed, agreedAt, version, withdrawnAt, currentVersion }.
// PUT 본문 { agreed: false }로 철회, { agreed: true, marketingVersion }으로 다시 동의(버전이 지금과 다르면 409 consent_outdated,
// agreed가 불리언이 아니면 400 invalid_marketing_consent). 이미 같은 상태면 바꾸지 않고 지금 상태를 돌려준다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const state = await readMarketingConsent(prisma, b.scope);
  if (!state) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  return noStore(NextResponse.json(state));
}

export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const r = await setMarketingConsent(prisma, b.scope, await readJson(req), requestMeta(req));
  if (!r.ok) {
    if (r.reason === "not_found") return noStore(NextResponse.json({ error: r.reason }, { status: 404 }));
    return noStore(NextResponse.json({ error: r.reason, message: MARKETING_CONSENT_MESSAGES[r.reason] }, { status: MARKETING_CONSENT_STATUS[r.reason] }));
  }
  return noStore(NextResponse.json(r.state));
});
