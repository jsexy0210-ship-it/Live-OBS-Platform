import { NextResponse } from "next/server";
import { SHOP_NOT_FOUND_MESSAGE } from "../../../../../../../lib/server/auth/messages";
import { confirmBuyerPasswordReset } from "../../../../../../../lib/server/buyers/passwordReset";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, readJson, requestMeta } from "../../../../../../../lib/server/http/route";

// 구매자 새 비밀번호 저장(SH-012). 실패 { error: weak_password(400) | token_invalid(400) | token_expired(410) }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug }, select: { id: true, status: true } });
  if (!seller || seller.status !== "ACTIVE") return NextResponse.json({ error: "not_found", message: SHOP_NOT_FOUND_MESSAGE }, { status: 404 });
  const body = await readJson<{ token: string; password: string }>(req);
  const r = await confirmBuyerPasswordReset(prisma, { sellerId: seller.id, token: body.token as string, password: body.password as string }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "token_expired" ? 410 : 400 });
  return NextResponse.json({ ok: true });
});
