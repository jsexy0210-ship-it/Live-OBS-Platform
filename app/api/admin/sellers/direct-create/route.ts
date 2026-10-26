import { NextResponse } from "next/server";
import { createSellerDirect, DIRECT_CREATE_MESSAGES, inviteLink } from "../../../../../lib/server/sellers/directCreate";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 파트너스 직접 추가(최고관리자만, system.manage). 본문 { shopName, slug, planCode?, ownerName, ownerEmail, reason(1~200자), trialEndsAt?(ISO, 기본 지금+7일, 상한 없음) }.
// 201 { sellerId, ownerUserId, trialEndsAt, invite: { path, url|null, expiresAt } } — 초대 링크는 이 응답에서만 한 번 보인다(DB에는 해시만). 400 invalid_input·invalid_slug·invalid_trial·invalid_reason, 409 slug_taken.
// 쇼핑몰은 바로 운영 중이지만 대표자 본인확인 대기(제한은 sellers/identityGate.ts). 로그 추적 admin.seller.direct_create(이메일·링크 없음).
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const b = await readJson<Record<string, unknown>>(req);
  const r = await createSellerDirect(prisma, admin, { shopName: b.shopName, slug: b.slug, planCode: b.planCode, ownerName: b.ownerName, ownerEmail: b.ownerEmail, reason: b.reason, trialEndsAt: b.trialEndsAt }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: DIRECT_CREATE_MESSAGES[r.reason] }, { status: r.reason === "slug_taken" ? 409 : 400, headers: { "cache-control": "no-store" } });
  const link = inviteLink(r.inviteToken, req.headers);
  return NextResponse.json({ sellerId: r.sellerId, ownerUserId: r.ownerUserId, trialEndsAt: r.trialEndsAt, invite: { path: link.path, url: link.url, expiresAt: r.inviteExpiresAt } }, { status: 201, headers: { "cache-control": "no-store" } });
});
