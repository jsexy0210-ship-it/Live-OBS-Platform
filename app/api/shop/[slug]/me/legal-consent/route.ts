import { NextResponse } from "next/server";
import { consentStatus, currentConsentDocs, readSignupConsent } from "../../../../../../lib/server/buyers/consent";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { noStore } from "../../../../../../lib/server/http/route";

// 구매자 본인이 가입 때 동의한 이용약관·개인정보 문서와, 지금 이 쇼핑몰의 동의 대상 버전이 달라졌는지(표시용 플래그, 강제 재동의 없음).
// → { recorded, termsOutdated, privacyOutdated, reconsentRequired, agreed: { termsVersion, privacyVersion, shopDocs?, agreedAt } | null,
//     current: { terms: { version, shop }, privacy: { version, shop } } }
// shop은 쇼핑몰이 게시한 문서의 { kind, version, effectiveOn }, 게시 전이면 null(플랫폼 서식 버전). 동의 기록이 없는 회원(이 기능 전 가입)은 recorded: false.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const [member, docs] = await Promise.all([
    prisma.buyerMember.findFirst({ where: { id: b.scope.buyerMemberId, sellerId: b.scope.sellerId }, select: { signupConsent: true } }),
    currentConsentDocs(prisma, b.scope.sellerId),
  ]);
  if (!member) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  const consent = readSignupConsent(member.signupConsent);
  return noStore(
    NextResponse.json({
      ...consentStatus(docs, consent),
      agreed: consent ? { termsVersion: consent.termsVersion, privacyVersion: consent.privacyVersion, shopDocs: consent.shopDocs ?? null, agreedAt: consent.agreedAt } : null,
      current: docs,
    }),
  );
}
