import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { PROFILE_MESSAGES, PROFILE_STATUS, changeBroadcastNickname } from "../../../../../../lib/server/buyers/profile";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";

// 방송 닉네임 변경(SH-024, 30일에 1번). 본문 { broadcastNickname }(20자). 지금과 같으면 그대로 200(제한을 쓰지 않음).
// 성공 → 내 정보와 같은 모양 { loginId, name, phoneMasked, broadcastNickname, nextNicknameChangeAt }. 틀린 값 400 invalid_nickname, 겹침 409 nickname_taken,
// 30일 안 409 nickname_change_limited(+nextNicknameChangeAt).
export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const r = await changeBroadcastNickname(prisma, b.scope, await readJson(req), requestMeta(req));
  if (!r.ok) {
    const extra = "nextNicknameChangeAt" in r ? { nextNicknameChangeAt: r.nextNicknameChangeAt } : {};
    return noStore(NextResponse.json({ error: r.reason, message: PROFILE_MESSAGES[r.reason], ...extra }, { status: PROFILE_STATUS[r.reason] }));
  }
  return noStore(NextResponse.json(r.profile));
});
