import { NextResponse } from "next/server";
import { REJOIN_RETENTION_MESSAGES, REJOIN_RETENTION_STATUS, readRejoinRetentionConsent, withdrawRejoinRetentionConsent } from "../../../../../../lib/server/buyers/rejoinConsent";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";

// 구매자 본인의 재가입 제한 정보 보관 동의(로그인한 쇼핑몰 회원만, 잠긴 쇼핑몰이어도 철회는 연다).
// GET → { agreed, agreedAt, version, restrictionDays, withdrawnAt }.
// PUT 본문 { agreed: false }로 철회(다시 동의는 없음, 그 밖의 본문은 400 invalid_rejoin_retention_consent). 이미 철회됐으면 지금 상태를 돌려준다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const state = await readRejoinRetentionConsent(prisma, b.scope);
  if (!state) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  return noStore(NextResponse.json(state));
}

export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const r = await withdrawRejoinRetentionConsent(prisma, b.scope, await readJson(req), requestMeta(req));
  if (!r.ok) {
    if (r.reason === "not_found") return noStore(NextResponse.json({ error: r.reason }, { status: 404 }));
    return noStore(NextResponse.json({ error: r.reason, message: REJOIN_RETENTION_MESSAGES[r.reason] }, { status: REJOIN_RETENTION_STATUS[r.reason] }));
  }
  return noStore(NextResponse.json(r.state));
});
