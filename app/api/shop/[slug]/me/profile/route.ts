import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { readMemberProfile } from "../../../../../../lib/server/buyers/profile";
import { prisma } from "../../../../../../lib/server/db";
import { noStore } from "../../../../../../lib/server/http/route";

// 회원정보 수정(SH-024) 내 정보 조회(로그인한 쇼핑몰 회원만).
// GET → { loginId, name, phoneMasked(010-****-1234), broadcastNickname, nextNicknameChangeAt(ISO | null: 닉네임을 다시 바꿀 수 있는 시각, 지금 바꿀 수 있으면 null) }.
// 아이디·이름은 바꿀 수 없다. 마케팅 수신 동의는 /me/marketing-consent.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const profile = await readMemberProfile(prisma, b.scope);
  if (!profile) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  return noStore(NextResponse.json(profile));
}
