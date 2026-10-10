import type { Metadata } from "next";
import "../../../../styles/seller.css";
import { SELLER_SIGNUP_CONSENT_VERSIONS } from "../../../../lib/server/sellers/signupConsent";
import { SignupFlow } from "../../../../components/seller/signup/SignupFlow";
import { PublicFrame } from "../../../../components/public/PublicFrame";
import { brandingMetadata } from "../../../../lib/server/branding/metadata";

export async function generateMetadata(): Promise<Metadata> {
  const { icons } = await brandingMetadata("seller");
  return { title: "파트너스 가입 신청 · 스트림샵", icons };
}

// PF-007 파트너스 가입 신청 단계 화면의 틀. 정본은 공개 화면 틀(머리 · 꼬리, 보라 브랜드) 안의 단계 화면이다.
// 필수 약관 버전은 서버 값을 화면에 넘긴다(화면과 서버가 같은 버전을 보게)
// seller.css는 본인확인 부품(IdentityCheck)이 쓰는 .pa-* 배치만 쓴다(.seller-app 안이 아니라 파트너스 파란 테마는 입히지 않는다)
export const dynamic = "force-dynamic";

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  const { terms, privacy, policy, marketing } = SELLER_SIGNUP_CONSENT_VERSIONS;
  return (
      <PublicFrame mobileHeader="compact">
      <SignupFlow consentVersions={{ termsVersion: terms, privacyVersion: privacy, policyVersion: policy, marketingVersion: marketing }}>{children}</SignupFlow>
    </PublicFrame>
  );
}
