// 라우트에서 HTTP 상태로 바꾸는 권한 오류.
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 402 | 403 | 404,
    readonly code: string,
  ) {
    super(code);
    this.name = "AuthError";
  }
}

export const unauthenticated = () => new AuthError(401, "unauthenticated");
export const forbidden = () => new AuthError(403, "forbidden");
// 다른 판매자 데이터는 존재 여부도 숨기려고 404로 응답한다.
export const notFound = () => new AuthError(404, "not_found");
// 체험하기가 끝났고 결제한 이용 기간도 없을 때. 구독·결제 화면과 로그아웃만 열린다.
export const subscriptionRequired = () => new AuthError(402, "subscription_required");
