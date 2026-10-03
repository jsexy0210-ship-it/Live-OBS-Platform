import { IDV_COOKIE } from "../../../../../lib/server/auth/passwordReset";
import { identityStepRoute } from "../../../../../lib/server/identity/http";

// 비밀번호 찾기 휴대폰 본인확인: 인증번호 다시 보내기(간격·횟수 제한)
export const POST = identityStepRoute("resend", "PASSWORD_RESET", IDV_COOKIE);
