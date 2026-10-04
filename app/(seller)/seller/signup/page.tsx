import { SELLER_SIGNUP_CONSENT_VERSIONS } from "../../../../lib/server/sellers/signupConsent";
import PartnersSignupForm from "./PartnersSignupForm";

// PF-007 파트너스 가입 신청. 필수 약관 버전은 서버 값을 화면에 넘긴다(화면과 서버가 같은 버전을 보게)
export const dynamic = "force-dynamic";

export default function PartnersSignupPage() {
  const { terms, privacy } = SELLER_SIGNUP_CONSENT_VERSIONS;
  return <PartnersSignupForm consentVersions={{ termsVersion: terms, privacyVersion: privacy }} />;
}
