import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { mutation, readCookie, readJson, requestMeta } from "../../../../lib/server/http/route";
import { businessStatusProvider, mailOrderProvider } from "../../../../lib/server/sellers/businessCheck";
import { SELLER_SIGNUP_IDV_COOKIE } from "../../../../lib/server/sellers/signupFlow";
import { checkSignupBusiness, ownedVerification } from "../../../../lib/server/sellers/signupAssist";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");

// 파트너스 가입(PF-007-4) 「조회」 버튼: 입력한 사업자번호·개업일(·통신판매업 신고번호)을 신청 전에 국세청·공정위로 미리 확인한다.
// 본문 { verificationId, businessNumber, openedOn, mailOrderNumber? }. 이 브라우저의 본인확인(완료·30분 안·아직 안 쓴 것)만 쓸 수 있고
// 본인확인 하나로 10번까지 조회한다(429 limit_exceeded). 조회 결과는 신청을 막지 않는다 — 신청 때 서버가 같은 점검을 다시 한다.
// 응답 { business: { lookup, valid, status }, duplicate, mailOrder: { state } | null }. 400 invalid_business_number · invalid_opened_on, 409 verification_invalid.
export const POST = mutation(async (req: Request) => {
  const body = await readJson<Record<string, unknown>>(req);
  const verificationId = str(body.verificationId, 36);
  if (!UUID.test(verificationId)) return NextResponse.json({ error: "verification_invalid" }, { status: 409 });
  const v = await ownedVerification(prisma, verificationId, readCookie(req, SELLER_SIGNUP_IDV_COOKIE));
  if (!v) return NextResponse.json({ error: "verification_invalid" }, { status: 409 });
  const r = await checkSignupBusiness(
    prisma,
    { business: businessStatusProvider(), mailOrder: mailOrderProvider() },
    v,
    { businessNumber: str(body.businessNumber, 20), openedOn: str(body.openedOn, 20), mailOrderNumber: str(body.mailOrderNumber, 100) || null },
    requestMeta(req),
  );
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "limit_exceeded" ? 429 : 400 });
  const { ok: _ok, ...rest } = r;
  return NextResponse.json(rest);
});
