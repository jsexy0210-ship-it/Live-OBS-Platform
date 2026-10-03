import type { LoginFailure } from "./login";

// 로그인 실패 사유별 화면 문구(해요체). 이메일과 비밀번호 중 무엇이 틀렸는지는 구분해서 알려 주지 않는다.
export const LOGIN_ERROR_MESSAGES: Record<LoginFailure | "bad_request", string> = {
  bad_request: "이메일과 비밀번호를 입력해 주세요",
  invalid_credentials: "이메일이나 비밀번호가 맞지 않아요",
  shop_required: "로그인할 쇼핑몰을 골라 주세요",
  account_disabled: "지금은 이 계정으로 로그인할 수 없어요. 쇼핑몰 대표자에게 문의해 주세요",
  seller_pending: "가입 승인을 기다리고 있어요. 승인되면 알려 드릴게요",
  seller_suspended: "지금은 쇼핑몰을 이용할 수 없어요. 고객센터에 문의해 주세요",
  seller_closed: "지금은 이 쇼핑몰로 로그인할 수 없어요. 고객센터에 문의해 주세요",
  dormant: "오래 쓰지 않아 쉬고 있는 계정이에요. 본인 확인 뒤 다시 쓸 수 있어요",
};

export const loginErrorBody = (code: LoginFailure | "bad_request") => ({ error: code, message: LOGIN_ERROR_MESSAGES[code] });
