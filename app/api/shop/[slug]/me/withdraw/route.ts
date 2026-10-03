import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { WITHDRAW_MESSAGES, withdrawBuyer } from "../../../../../../lib/server/buyers/withdraw";
import { prisma } from "../../../../../../lib/server/db";
import { clearSessionCookie, mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";

// 구매자 탈퇴(본인 세션). 본문 { password }. 진행 중인 주문이 있으면 409 orders_in_progress, 비밀번호가 틀리면 400 wrong_password.
// 성공하면 세션 쿠키를 지운다. 잠긴 쇼핑몰이어도 탈퇴는 연다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const body = await readJson<{ password: unknown }>(req);
  const password = typeof body.password === "string" && body.password.length <= 400 ? body.password : "";
  const r = await withdrawBuyer(prisma, b.scope, { password, meta: requestMeta(req) });
  if (!r.ok) {
    const status = r.reason === "orders_in_progress" ? 409 : r.reason === "not_found" ? 404 : 400;
    return noStore(NextResponse.json({ error: r.reason, message: WITHDRAW_MESSAGES[r.reason] }, { status }));
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res, "buyer");
  return noStore(res);
});
