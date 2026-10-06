import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";

// 구매자 새 비밀번호 기준(SH-004 가입·SH-012 재설정·SH-024 변경, MASTER 결정 2026-10-06): 영문과 숫자를 섞어 8자 이상.
// 새로 만들 때만 적용한다(이미 쓰는 비밀번호는 로그인 때 검사하지 않는다). 파트너스·관리자 비밀번호 기준은 따로 둔다.
export const BUYER_PASSWORD_MAX = 200;

export function isAcceptableBuyerPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH && password.length <= BUYER_PASSWORD_MAX && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export const BUYER_PASSWORD_RULE_MESSAGE = "비밀번호는 영문과 숫자를 섞어 8자 이상으로 정해 주세요";
