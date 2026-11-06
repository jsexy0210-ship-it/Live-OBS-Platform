import { NextResponse } from "next/server";
import { acceptInvite, DIRECT_CREATE_MESSAGES } from "../../../../../lib/server/sellers/directCreate";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta } from "../../../../../lib/server/http/route";

// 초대 링크로 첫 비밀번호 정하기(로그인 전 공개 경로). 본문 { token, newPassword }. 토큰은 링크의 # 조각에서 화면이 읽어 본문으로 보낸다(주소·서버 로그에 남지 않음).
// 200 { ok: true, shopSlug } — 이후 그 쇼핑몰로 로그인 · 400 invalid_invite(무효·만료·사용됨·무효화 모두 같은 답)·weak_password. 같은 비밀번호로 10분 안에 다시 보내면 200(응답 유실 대비).
export const POST = mutation(async (req: Request) => {
  const b = await readJson<{ token?: unknown; newPassword?: unknown }>(req);
  const r = await acceptInvite(prisma, { token: b.token, newPassword: b.newPassword }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: DIRECT_CREATE_MESSAGES[r.reason] }, { status: 400, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ ok: true, shopSlug: r.shopSlug }, { headers: { "cache-control": "no-store" } });
});
