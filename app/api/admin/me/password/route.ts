import { NextResponse } from "next/server";
import { ACCOUNT_MESSAGES, changeAdminPassword } from "../../../../../lib/server/auth/account";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 마스터 관리자 내 비밀번호 바꾸기(MA-090). 모든 역할(최고관리자 포함)이 본인 것만, 대상 id는 받지 않는다. 본문 { currentPassword, newPassword, signOutOthers: boolean(필수) }.
// signOutOthers true면 이 세션만 남기고 다른 세션은 로그아웃. 로그 추적에 남긴다(비밀번호 값 없음). 성공 { ok: true, signedOutOthers, signedOutSessions },
// 실패 400 { error, message }: bad_request·weak_password·same_password·wrong_password·changed_elsewhere
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
  const body = await readJson<{ currentPassword: unknown; newPassword: unknown; signOutOthers: unknown }>(req);
  const r = await changeAdminPassword(prisma, admin.admin.id, admin.sessionId, body, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: ACCOUNT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ ok: true, signedOutOthers: r.signedOutOthers, signedOutSessions: r.signedOutSessions });
});
