import { identityStepRoute } from "../../../../../../lib/server/identity/http";
import { STAFF_LINK_IDV_COOKIE } from "../../../../../../lib/server/sellers/staffIdentityFlow";

// 직원 본인확인 연결: 인증번호 다시 보내기(간격·횟수 제한)
export const POST = identityStepRoute("resend", "STAFF_LINK", STAFF_LINK_IDV_COOKIE);
