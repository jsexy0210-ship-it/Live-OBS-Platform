import { NextResponse } from "next/server";
import { isEmailLengthOk } from "../../../../../../../lib/server/auth/login";
import { SHOP_NOT_FOUND_MESSAGE } from "../../../../../../../lib/server/auth/messages";
import { requestBuyerPasswordReset } from "../../../../../../../lib/server/buyers/passwordReset";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, readJson, requestMeta } from "../../../../../../../lib/server/http/route";
import { mailSender } from "../../../../../../../lib/server/mail/registry";

// 메일 링크의 서버 주소. 요청 Host로 만들면 남이 Host를 속여 링크를 바꿀 수 있어 운영은 APP_ORIGIN(공개 주소)만 쓴다.
// 개발·테스트는 같은 출처로 확인된 요청 Origin을 쓴다.
function linkOrigin(req: Request): string | null {
  const fixed = process.env.APP_ORIGIN?.replace(/\/+$/, "");
  if (fixed) return fixed;
  return process.env.NODE_ENV === "production" ? null : (req.headers.get("origin") ?? null);
}

// 구매자 비밀번호 재설정 요청(SH-012). 가입된 이메일인지와 상관없이 같은 응답 { ok: true }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug }, select: { id: true, status: true, shopName: true } });
  if (!seller || seller.status !== "ACTIVE") return NextResponse.json({ error: "not_found", message: SHOP_NOT_FOUND_MESSAGE }, { status: 404 });
  const body = await readJson<{ loginId: string }>(req);
  if (!isEmailLengthOk(body.loginId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const origin = linkOrigin(req);
  const r = await requestBuyerPasswordReset(prisma, origin ? mailSender() : null, { sellerId: seller.id, shopSlug: slug, shopName: seller.shopName, loginId: body.loginId, origin: origin ?? "" }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "too_many_requests" ? 429 : 503 });
  return NextResponse.json({ ok: true });
});
