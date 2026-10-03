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
  wrong_account_type: "고른 탭과 계정 종류가 달라요. 다른 탭에서 로그인해 주세요",
};

// 구매자는 아이디로 로그인하고, 마스터는 판매자와 문의처가 다르다. 그 밖의 사유는 판매자 문구를 그대로 쓴다.
const REALM_OVERRIDES: Record<"admin" | "buyer", Partial<Record<LoginFailure | "bad_request", string>>> = {
  admin: {
    account_disabled: "지금은 이 계정으로 로그인할 수 없어요. 최고관리자에게 문의해 주세요",
  },
  buyer: {
    bad_request: "아이디와 비밀번호를 입력해 주세요",
    invalid_credentials: "아이디나 비밀번호가 맞지 않아요",
    account_disabled: "지금은 이 계정으로 로그인할 수 없어요. 쇼핑몰에 문의해 주세요",
  },
};

export const loginErrorBody = (code: LoginFailure | "bad_request", realm: "seller" | "admin" | "buyer" = "seller") => ({
  error: code,
  message: (realm === "seller" ? undefined : REALM_OVERRIDES[realm][code]) ?? LOGIN_ERROR_MESSAGES[code],
});

// 구매자 로그인에서 쇼핑몰이 없거나 운영 중이 아닐 때(판매자 사정은 드러내지 않음)
export const SHOP_NOT_FOUND_MESSAGE = "지금은 쇼핑몰을 이용할 수 없어요";
