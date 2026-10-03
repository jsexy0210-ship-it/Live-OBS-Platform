import { identityStepRoute } from "../../../../../../lib/server/identity/http";
import { STAFF_LINK_IDV_COOKIE } from "../../../../../../lib/server/sellers/staffIdentityFlow";

// 직원 본인확인 연결: 인증번호 확인(본문 { verificationId, code }). 그다음 link로 계정에 연결한다
export const POST = identityStepRoute("confirm", "STAFF_LINK", STAFF_LINK_IDV_COOKIE);
