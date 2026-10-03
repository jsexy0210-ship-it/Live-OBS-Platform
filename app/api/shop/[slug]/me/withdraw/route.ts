import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { WITHDRAW_MESSAGES, WITHDRAW_STATUS, withdrawBuyer } from "../../../../../../lib/server/buyers/withdraw";
import { prisma } from "../../../../../../lib/server/db";
import { clearSessionCookie, mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";

// 구매자 탈퇴(본인 세션). 본문 { password }. 진행 중인 주문이 있으면 409 orders_in_progress,
// 비밀번호가 틀리면 구매자 로그인과 같은 401 invalid_credentials.
// 성공하면 세션 쿠키를 지운다. 잠긴 쇼핑몰이어도 탈퇴는 연다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const body = await readJson<{ password: unknown }>(req);
  const password = typeof body.password === "string" && body.password.length <= 400 ? body.password : "";
  const r = await withdrawBuyer(prisma, b.scope, { password, meta: requestMeta(req) });
  if (!r.ok) {
    return noStore(NextResponse.json({ error: r.reason, message: WITHDRAW_MESSAGES[r.reason] }, { status: WITHDRAW_STATUS[r.reason] }));
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res, "buyer");
  return noStore(res);
});
