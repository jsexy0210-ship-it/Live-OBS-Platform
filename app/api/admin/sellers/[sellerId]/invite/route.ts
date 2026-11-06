import { NextResponse } from "next/server";
import { DIRECT_CREATE_MESSAGES, inviteLink, reissueInvite } from "../../../../../../lib/server/sellers/directCreate";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 초대 다시 만들기(최고관리자만). 직접 추가한 쇼핑몰의 대표자에게만: 이전 미사용 초대는 모두 무효가 되고 새 링크는 이 응답에서 한 번만 보인다.
// 200 { invite: { path, url|null, expiresAt }, revokedInvites } · 400 invalid_target·identity_verified(대표자 본인확인이 끝난 쇼핑몰은 거절 — 대표자 본인 인증으로만 복구). 로그 추적 admin.seller.invite_reissue(링크 없음).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const r = await reissueInvite(prisma, admin, (await params).sellerId, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: DIRECT_CREATE_MESSAGES[r.reason] }, { status: 400, headers: { "cache-control": "no-store" } });
  const link = inviteLink(r.inviteToken, req.headers);
  return NextResponse.json({ invite: { path: link.path, url: link.url, expiresAt: r.inviteExpiresAt }, revokedInvites: r.revokedInvites }, { headers: { "cache-control": "no-store" } });
});
