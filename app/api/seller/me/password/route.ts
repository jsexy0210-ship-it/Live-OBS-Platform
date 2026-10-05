import { NextResponse } from "next/server";
import { ACCOUNT_MESSAGES, changeSellerPassword } from "../../../../../lib/server/auth/account";
import { resolveSellerSession } from "../../../../../lib/server/auth/session";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { forbidden, unauthenticated } from "../../../../../lib/server/authz/errors";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 내 비밀번호 바꾸기(SA-120). 파트너스 계정 누구나 본인 것만(첫 결제 전·잠김·이용 정지 중에도). 본문 { currentPassword, newPassword, signOutOthers: boolean(필수) }.
// signOutOthers true면 이 세션만 남기고 다른 곳은 로그아웃, false면 다른 세션은 그대로. 마스터 대리 조회는 403.
// 성공 { ok: true, signedOutOthers, signedOutSessions }, 실패 400 { error, message }: bad_request·weak_password·same_password·wrong_password·changed_elsewhere
export const POST = mutation(async (req: Request) => {
  const token = sessionToken(req, "seller");
  const ctx = await requireSeller(prisma, token, undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  if (ctx.readOnly) throw forbidden();
  const session = await resolveSellerSession(prisma, token);
  if (!session) throw unauthenticated();
  const body = await readJson<{ currentPassword: unknown; newPassword: unknown; signOutOthers: unknown }>(req);
  const r = await changeSellerPassword(prisma, ctx, session.sessionId, body, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: ACCOUNT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ ok: true, signedOutOthers: r.signedOutOthers, signedOutSessions: r.signedOutSessions });
});
