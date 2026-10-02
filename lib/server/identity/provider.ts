// PASS 본인인증 공급자 인터페이스. 실제 PASS 대행사 연동은 계약 후 이 인터페이스로 붙인다.
// 개발·테스트는 FakeIdentityProvider만 쓴다.

export type IdentityResult =
  | { ok: true; ci: string; name: string; phone: string; birthDate: Date }
  | { ok: false; reason: "failed" | "pending" };

export interface IdentityProvider {
  readonly name: string;
  // 인증 창을 열 요청 id를 만든다.
  createRequest(): Promise<{ requestId: string }>;
  // 인증이 끝난 뒤 결과를 공급자에서 받아 온다(브라우저가 보낸 값은 믿지 않는다).
  fetchResult(requestId: string): Promise<IdentityResult>;
}

export class FakeIdentityProvider implements IdentityProvider {
  readonly name = "fake";
  private seq = 0;
  private results = new Map<string, IdentityResult>();

  async createRequest() {
    return { requestId: `fake-${Date.now()}-${++this.seq}` };
  }

  // 테스트에서 인증 결과를 정한다.
  complete(requestId: string, person: { ci: string; name: string; phone: string; birthDate: Date }) {
    this.results.set(requestId, { ok: true, ...person });
  }

  fail(requestId: string) {
    this.results.set(requestId, { ok: false, reason: "failed" });
  }

  async fetchResult(requestId: string): Promise<IdentityResult> {
    return this.results.get(requestId) ?? { ok: false, reason: "pending" };
  }
}
