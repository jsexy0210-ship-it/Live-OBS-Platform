import { RECOVERY_IDV_COOKIE } from "../../../../../lib/server/auth/recoveryFlow";
import { identityStepRoute } from "../../../../../lib/server/identity/http";

// 파트너스 아이디 찾기 휴대폰 본인확인: 인증번호 확인(본문 { verificationId, code }). 그다음 accounts로 계정 목록을 본다
export const POST = identityStepRoute("confirm", "ACCOUNT_RECOVERY", RECOVERY_IDV_COOKIE);
