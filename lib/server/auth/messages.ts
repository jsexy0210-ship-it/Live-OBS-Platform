import type { LoginFailure } from "./login";

// 로그인 실패 사유별 화면 문구. 이메일과 비밀번호 중 무엇이 틀렸는지는 구분해서 알려 주지 않는다.
// 파트너스·마스터 관리자 로그인은 합니다체, 구매자 로그인은 해요체(lib/server/text/tone.ts).
export const LOGIN_ERROR_MESSAGES: Record<LoginFailure | "bad_request", string> = {
  bad_request: "이메일과 비밀번호를 입력해 주십시오",
  invalid_credentials: "이메일이나 비밀번호가 맞지 않습니다",
  shop_required: "로그인할 쇼핑몰을 골라 주십시오",
  account_disabled: "지금은 이 계정으로 로그인할 수 없습니다. 쇼핑몰 대표자에게 문의해 주십시오",
  seller_pending: "가입 신청을 확인하고 있습니다. 확인이 끝나면 알려 드립니다",
  seller_suspended: "지금은 쇼핑몰을 이용할 수 없습니다. 고객센터에 문의해 주십시오",
  seller_closed: "지금은 이 쇼핑몰로 로그인할 수 없습니다. 고객센터에 문의해 주십시오",
  dormant: "오래 쓰지 않아 쉬고 있는 계정입니다. 「아이디/비밀번호 찾기」에서 본인 확인을 하면 다시 쓸 수 있습니다",
  wrong_account_type: "고른 탭과 계정 종류가 다릅니다. 다른 탭에서 로그인해 주십시오",
};

// 구매자 로그인(해요체, 아이디로 로그인)
export const BUYER_LOGIN_ERROR_MESSAGES: Record<LoginFailure | "bad_request", string> = {
  bad_request: "아이디와 비밀번호를 입력해 주세요",
  invalid_credentials: "아이디나 비밀번호가 맞지 않아요",
  shop_required: "로그인할 쇼핑몰을 골라 주세요",
  account_disabled: "지금은 이 계정으로 로그인할 수 없어요. 쇼핑몰에 문의해 주세요",
  seller_pending: "쇼핑몰이 아직 문을 열 준비를 하고 있어요. 열리면 로그인해 주세요",
  seller_suspended: "지금은 쇼핑몰을 이용할 수 없어요. 고객센터에 문의해 주세요",
  seller_closed: "지금은 이 쇼핑몰로 로그인할 수 없어요. 고객센터에 문의해 주세요",
  dormant: "오래 쓰지 않아 쉬고 있는 계정이에요. 쇼핑몰에 문의하면 다시 쓸 수 있어요",
  wrong_account_type: "이 계정으로는 이 쇼핑몰에 로그인할 수 없어요. 가입한 쇼핑몰 주소에서 다시 로그인해 주세요",
};

// 마스터 관리자는 파트너스와 문의처가 다르다. 그 밖의 사유는 파트너스 문구를 그대로 쓴다.
const ADMIN_OVERRIDES: Partial<Record<LoginFailure | "bad_request", string>> = {
  account_disabled: "지금은 이 계정으로 로그인할 수 없습니다. 최고관리자에게 문의해 주십시오",
};

export const loginErrorBody = (code: LoginFailure | "bad_request", realm: "seller" | "admin" | "buyer" = "seller") => ({
  error: code,
  message: realm === "buyer" ? BUYER_LOGIN_ERROR_MESSAGES[code] : ((realm === "admin" ? ADMIN_OVERRIDES[code] : undefined) ?? LOGIN_ERROR_MESSAGES[code]),
});

// 구매자 로그인에서 쇼핑몰이 없거나 운영 중이 아닐 때(판매자 사정은 드러내지 않음)
export const SHOP_NOT_FOUND_MESSAGE = "지금은 쇼핑몰을 이용할 수 없어요";
