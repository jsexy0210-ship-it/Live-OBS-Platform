// 휴대폰 본인확인 화면 문구(해요체). 화면은 error 코드로 분기하고 message를 그대로 보여 준다. 문구는 여기서만 고친다.
export const IDENTITY_UNAVAILABLE_MESSAGE = "본인확인 서비스 준비 중이에요";

export const IDENTITY_ERROR_MESSAGES = {
  identity_unavailable: IDENTITY_UNAVAILABLE_MESSAGE,
  invalid_identity_input: "이름, 휴대폰번호, 생년월일, 통신사를 다시 확인해 주세요",
  provider_error: "지금은 본인확인을 할 수 없어요. 잠시 뒤 다시 해 주세요",
  not_found: "본인확인을 처음부터 다시 해 주세요",
  expired: "본인확인 시간이 지났어요. 처음부터 다시 해 주세요",
  failed: "본인확인에 실패했어요. 입력한 정보를 확인하고 처음부터 다시 해 주세요",
  wrong_code: "인증번호가 맞지 않아요. 다시 확인해 주세요",
  code_expired: "인증번호 유효 시간이 지났어요. 인증번호를 다시 받아 주세요",
  too_many_attempts: "인증번호를 여러 번 틀렸어요. 처음부터 다시 해 주세요",
  resend_too_soon: "인증번호를 보냈어요. 잠시 뒤에 다시 받을 수 있어요",
  resend_limit: "인증번호를 너무 많이 받았어요. 처음부터 다시 해 주세요",
  already_verified: "이미 본인확인을 마쳤어요",
  trial_limit_exceeded: "지금은 가입할 수 없어요. 쇼핑몰에 문의해 주세요",
} as const;

export type IdentityErrorCode = keyof typeof IDENTITY_ERROR_MESSAGES;

export const IDENTITY_ERROR_STATUS: Record<IdentityErrorCode, number> = {
  identity_unavailable: 503,
  invalid_identity_input: 400,
  provider_error: 502,
  not_found: 404,
  expired: 410,
  failed: 400,
  wrong_code: 400,
  code_expired: 400,
  too_many_attempts: 429,
  resend_too_soon: 429,
  resend_limit: 429,
  already_verified: 409,
  trial_limit_exceeded: 403,
};

export const identityErrorBody = (code: IdentityErrorCode) => ({ error: code, message: IDENTITY_ERROR_MESSAGES[code] });
