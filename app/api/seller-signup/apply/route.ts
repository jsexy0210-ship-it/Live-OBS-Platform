import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { mutation, readCookie, readJson, requestMeta } from "../../../../lib/server/http/route";
import { identityProvider, identityUnavailable } from "../../../../lib/server/identity/registry";
import { completeIdentityVerification } from "../../../../lib/server/identity/verification";
import { REPRESENTATIVE_HAS_SHOP_MESSAGE, applyForSeller } from "../../../../lib/server/sellers/application";
import { businessStatusProvider, mailOrderProvider } from "../../../../lib/server/sellers/businessCheck";
import { SELLER_CONSENT_MESSAGES } from "../../../../lib/server/sellers/signupConsent";
import { SELLER_SIGNUP_IDV_COOKIE } from "../../../../lib/server/sellers/signupFlow";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max = 200) => (typeof v === "string" && v.length <= max ? v : "");

// 판매자 가입 신청 2단계: 휴대폰 본인확인 완료 확인 → 신청 → 자동 점검. 모두 통과하면 바로 승인(approved: true),
// 아니면 승인 대기(「확인 필요」, reviewReasons). 본인확인 기록에 필수 동의가 없으면 400 terms_required(약관 동의부터 다시).
// 동의 기록(문서 버전·시각)은 대표자 계정에 저장한다.
export const POST = mutation(async (req: Request) => {
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<Record<string, unknown>>(req);
  const verificationId = str(body.verificationId, 36);
  if (!UUID.test(verificationId)) return NextResponse.json({ error: "verification_invalid" }, { status: 400 });
  const ownerToken = readCookie(req, SELLER_SIGNUP_IDV_COOKIE);
  const done = await completeIdentityVerification(prisma, provider, verificationId, {
    sellerId: null,
    purpose: "SELLER_REPRESENTATIVE",
    ownerToken,
  });
  if (!done.ok) {
    if (done.reason === "pending") return NextResponse.json({ error: "verification_pending" }, { status: 409 });
    // 이미 쓴 본인확인(신청을 만든 뒤 응답을 잃은 재시도)은 유효 시간이 지났어도 아래 applyForSeller의 재개 확인으로 넘긴다.
    // 재개 확인은 시작한 브라우저(쿠키)·같은 이메일·비밀번호·주소일 때만 결과를 돌려준다. 새 신청은 지금처럼 거부한다.
    const used = await prisma.identityVerification.findUnique({ where: { id: verificationId }, select: { consumedAt: true } });
    if (!used?.consumedAt) return NextResponse.json({ error: "verification_invalid" }, { status: 400 });
  }

  const r = await applyForSeller(prisma, { business: businessStatusProvider(), mailOrder: mailOrderProvider() }, {
    verificationId,
    ownerToken,
    email: str(body.email),
    password: str(body.password),
    shopName: str(body.shopName),
    slug: str(body.slug, 40),
    businessNumber: str(body.businessNumber, 20),
    companyName: str(body.companyName),
    openedOn: str(body.openedOn, 20),
    mailOrderNumber: str(body.mailOrderNumber, 100) || null,
    // 문자열이 아닌 값은 그대로 거절되게 넘긴다(빈 값으로 바꿔 기본 플랜이 되지 않게)
    planCode: body.planCode == null ? null : typeof body.planCode === "string" ? body.planCode.slice(0, 40) : "invalid",
    meta: requestMeta(req),
  });
  if (!r.ok) {
    if (r.reason === "representative_has_shop") {
      return NextResponse.json({ error: r.reason, message: REPRESENTATIVE_HAS_SHOP_MESSAGE }, { status: 409 });
    }
    if (r.reason === "terms_required" || r.reason === "consent_outdated") return NextResponse.json({ error: r.reason, message: SELLER_CONSENT_MESSAGES[r.reason] }, { status: 400 });
    return NextResponse.json({ error: r.reason }, { status: r.reason === "slug_taken" ? 409 : 400 });
  }
  // 흐름 쿠키는 성공해도 지우지 않는다. 성공 응답이 잘려 브라우저가 결과를 못 받았을 때 같은 요청을 다시 보내면 이 쿠키로
  // 이미 만든 신청을 돌려받는다(resumed). 쿠키는 시작 때 정한 유효 시간(40분)이 지나면 사라진다.
  return NextResponse.json({ approved: r.approved, reviewReasons: r.reviewReasons, resumed: r.resumed });
});
