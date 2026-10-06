import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { PROFILE_MESSAGES, PROFILE_STATUS, changeMemberPassword } from "../../../../../../lib/server/buyers/profile";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";

// 비밀번호 변경(SH-024). 본문 { currentPassword, newPassword }(8자 이상). 바꾸면 지금 세션만 남기고 이 회원의 다른 로그인 세션은 모두 끝난다.
// 성공 → { ok: true, revokedSessions }. 새 비밀번호가 약하면 400 weak_password, 지금과 같으면 400 same_password, 현재 비밀번호가 틀리면 403 wrong_password
// (10분에 5번 넘게 틀리면 429 too_many_attempts). 401은 로그인 만료에만 쓴다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const r = await changeMemberPassword(prisma, b.scope, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PROFILE_MESSAGES[r.reason] }, { status: PROFILE_STATUS[r.reason] }));
  return noStore(NextResponse.json({ ok: true, revokedSessions: r.revokedSessions }));
});
