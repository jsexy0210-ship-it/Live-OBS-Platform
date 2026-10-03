import { IDV_COOKIE } from "../../../../../lib/server/auth/passwordReset";
import { identityStepRoute } from "../../../../../lib/server/identity/http";

// 비밀번호 찾기 휴대폰 본인확인: 인증번호 확인(본문 { verificationId, code }) → 서버 결과 조회로 확정. 그다음 verify로 재설정 권한을 받는다
export const POST = identityStepRoute("confirm", "PASSWORD_RESET", IDV_COOKIE);
