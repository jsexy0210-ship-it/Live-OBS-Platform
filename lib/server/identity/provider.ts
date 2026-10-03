// 휴대폰 본인확인(문자) 공급자 인터페이스(대표님 결정 2026-10-03, PRODUCT_SCOPE 「휴대폰 본인확인 방식」).
// 본인확인기관 대행사의 정식 「문자로 본인확인」: 인적사항 대조 + 문자 인증번호. 일반 문자 발송으로 번호 소유만 보는 방식은 쓰지 않는다.
// 흐름: 인증번호 보내기(send) → 다시 보내기(resend) → 인증번호 확인(confirm) → 서버 결과 조회(fetchResult, 이 결과만 믿는다).
// 실제 대행사(포트원 V2 + KCP 후보)는 계약 전이라 portone.ts는 경계만 있고 실제 호출은 검증하지 않았다.
// 개발·테스트는 FakeIdentityProvider만 쓴다(운영에서는 만들 수 없다).

export const CARRIERS = ["SKT", "KT", "LGU", "SKT_MVNO", "KT_MVNO", "LGU_MVNO"] as const;
export type Carrier = (typeof CARRIERS)[number];

// 화면 기기. KCP API 방식은 PC(MC01)·모바일(MC02)을 꼭 보내야 한다(포트원 kcp-v2-identity-verification.mdx).
export const DEVICES = ["PC", "MOBILE"] as const;
export type Device = (typeof DEVICES)[number];

// 인적사항. birth7: 생년월일 6자리 + 성별 자리 1자리(주민등록번호 전체는 받지 않는다). device: 화면 기기(기본 MOBILE).
export type IdentityPerson = { name: string; phone: string; birth7: string; carrier: Carrier; device: Device };

export type IdentityPurposeTag = "BUYER_SIGNUP" | "SELLER_REPRESENTATIVE" | "PASSWORD_RESET" | "STAFF_LINK" | "ACCOUNT_RECOVERY";

export type IdentityResult =
  // requestId·purpose: 대행사 결과에 실려 온 요청 id와 서비스(용도). 우리 기록과 대조한다.
  | { ok: true; requestId: string; purpose: IdentityPurposeTag; ci: string; name: string; phone: string; birthDate: Date }
  | { ok: false; reason: "failed" | "pending" };

// 공급자 호출 실패(장애·타임아웃·알 수 없는 응답)는 이 값으로 돌려준다(예외를 밖으로 던지지 않는다).
export type ProviderFailure = { ok: false; reason: "provider_error" };

export interface IdentityProvider {
  readonly name: string;
  // 인증번호 보내기. requestId는 우리가 만든 요청 id(대행사 본인인증 id로 쓴다).
  sendCode(requestId: string, purpose: IdentityPurposeTag, person: IdentityPerson): Promise<{ ok: true } | ProviderFailure>;
  resendCode(requestId: string): Promise<{ ok: true } | ProviderFailure>;
  // 인증번호 확인. 틀리면 wrong_code.
  confirmCode(requestId: string, otp: string): Promise<{ ok: true } | { ok: false; reason: "wrong_code" } | ProviderFailure>;
  // 서버 간 결과 조회. 브라우저가 보낸 값은 믿지 않는다.
  fetchResult(requestId: string): Promise<IdentityResult | ProviderFailure>;
}

// 가짜 공급자의 인증번호. 이 번호로만 확인에 성공한다(개발·테스트 전용).
export const FAKE_IDENTITY_OTP = "000000";

type FakeRequest = { purpose: IdentityPurposeTag; person: IdentityPerson; confirmed: boolean; at: number };

// 테스트 서버 모드(오래 도는 서버)에서 가짜 공급자가 메모리에 들고 있는 요청의 수명과 보낸 기록 개수 상한.
// 본인확인 요청은 10분이면 끝나므로 1시간 지난 요청은 지우고, 요청 수와 보낸 기록은 최근 것만 남긴다.
export const FAKE_REQUEST_TTL_MS = 3600_000;
export const FAKE_SENT_KEEP = 1000;
// 메모리에 들고 있는 요청 수 상한. 1시간 안에 이보다 많이 오면 가장 오래된 요청부터 지운다(짧은 시간에 몰려도 메모리가 정해진 크기 안).
export const FAKE_REQUEST_KEEP = 2000;
type FakePerson = { ci: string; name: string; phone: string; birthDate: Date };

export class FakeIdentityProvider implements IdentityProvider {
  readonly name = "fake";
  private requests = new Map<string, FakeRequest>();
  private people = new Map<string, FakePerson | "failed">();
  // 테스트: 다음 호출을 장애(error)나 응답 없음(hang, 타임아웃 시험)으로 만든다.
  // afterHang: 대행사에서는 처리됐지만 응답이 오지 않는 경우(인증번호 확인에만 적용).
  private nextFault: "error" | "hang" | "afterHang" | null = null;
  // 테스트: 인증번호 확인 호출 횟수
  confirmCalls = 0;
  // 테스트: 다음 결과 조회 한 번만 장애로 만든다(확인은 성공한 뒤 조회만 실패하는 경우)
  failNextResult = false;
  // 테스트: 다음 결과 조회에 다른 요청 id·용도를 실어 보낸다(위조·뒤바뀐 결과 시험).
  private nextResultOverride: Partial<{ requestId: string; purpose: IdentityPurposeTag }> | null = null;
  readonly sent: string[] = [];

  // 운영 환경에서는 만들 수 없다. 가짜 인증으로 가입·대표자 인증이 통과되는 것을 막는다.
  // 테스트 서버 모드(OBS_TEST_MODE=1, testMode.ts)만 예외로 허용한다.
  constructor(env: string | undefined = process.env.NODE_ENV, opts: { testMode?: boolean } = {}) {
    if (env === "production" && !opts.testMode) throw new Error("운영 환경에서는 가짜 본인확인 공급자를 쓸 수 없어요.");
    this.bounded = !!opts.testMode;
  }

  // 테스트 서버 모드면 요청을 보낼 때마다 오래된 요청을 지우고 보낸 기록 개수를 줄인다(공개 서버에서 메모리가 끝없이 늘지 않게).
  private readonly bounded: boolean;
  private prune(now = Date.now()) {
    if (!this.bounded) return;
    for (const [id, r] of this.requests) {
      if (now - r.at <= FAKE_REQUEST_TTL_MS) break; // 넣은 순서대로라 처음으로 남길 요청에서 멈춘다
      this.requests.delete(id);
      this.people.delete(id);
    }
  }
  private record(requestId: string) {
    this.sent.push(requestId);
    if (this.bounded && this.sent.length > FAKE_SENT_KEEP) this.sent.splice(0, this.sent.length - FAKE_SENT_KEEP);
  }

  // 메모리에 남아 있는 요청 수(테스트용)
  get pendingRequestCount() {
    return this.requests.size;
  }

  failNext(kind: "error" | "hang" | "afterHang") {
    this.nextFault = kind;
  }

  overrideNextResult(v: Partial<{ requestId: string; purpose: IdentityPurposeTag }>) {
    this.nextResultOverride = v;
  }

  // 테스트에서 이 요청의 명의 정보를 정한다(정하지 않으면 입력한 인적사항으로 만든다).
  complete(requestId: string, person: FakePerson) {
    this.people.set(requestId, person);
  }

  fail(requestId: string) {
    this.people.set(requestId, "failed");
  }

  private async fault(): Promise<ProviderFailure | null> {
    const f = this.nextFault === "afterHang" ? null : this.nextFault;
    if (f) this.nextFault = null;
    if (f === "hang") return new Promise(() => undefined);
    return f === "error" ? { ok: false, reason: "provider_error" } : null;
  }

  async sendCode(requestId: string, purpose: IdentityPurposeTag, person: IdentityPerson) {
    const f = await this.fault();
    if (f) return f;
    this.prune();
    this.requests.set(requestId, { purpose, person, confirmed: false, at: Date.now() });
    if (this.bounded) {
      // 넣은 순서대로라 맨 앞이 가장 오래된 요청이다
      for (const id of this.requests.keys()) {
        if (this.requests.size <= FAKE_REQUEST_KEEP) break;
        this.requests.delete(id);
        this.people.delete(id);
      }
    }
    this.record(requestId);
    return { ok: true as const };
  }

  async resendCode(requestId: string) {
    const f = await this.fault();
    if (f) return f;
    if (!this.requests.has(requestId)) return { ok: false as const, reason: "provider_error" as const };
    this.record(requestId);
    return { ok: true as const };
  }

  async confirmCode(requestId: string, otp: string) {
    this.confirmCalls++;
    const f = await this.fault();
    if (f) return f;
    const r = this.requests.get(requestId);
    if (!r) return { ok: false as const, reason: "provider_error" as const };
    // 포트원처럼 같은 요청은 한 번만 성공한다(이미 확인된 요청에 다시 보내면 400 → wrong_code)
    if (otp !== FAKE_IDENTITY_OTP || r.confirmed) return { ok: false as const, reason: "wrong_code" as const };
    r.confirmed = true;
    if (this.nextFault === "afterHang") {
      this.nextFault = null;
      return new Promise<never>(() => undefined);
    }
    return { ok: true as const };
  }

  async fetchResult(requestId: string): Promise<IdentityResult | ProviderFailure> {
    const f = await this.fault();
    if (f) return f;
    if (this.failNextResult) {
      this.failNextResult = false;
      return { ok: false, reason: "provider_error" };
    }
    const r = this.requests.get(requestId);
    const set = this.people.get(requestId);
    if (set === "failed") return { ok: false, reason: "failed" };
    if (!r || !r.confirmed) return { ok: false, reason: "pending" };
    const o = this.nextResultOverride ?? {};
    this.nextResultOverride = null;
    const birthDate = birthDateOf(r.person.birth7) ?? new Date("2000-01-01");
    const person = set ?? { ci: `fake-ci:${r.person.name}:${r.person.birth7}`, name: r.person.name, phone: r.person.phone, birthDate };
    return { ok: true, requestId: o.requestId ?? requestId, purpose: o.purpose ?? r.purpose, ...person };
  }
}

// 생년월일 6자리 + 성별 자리 → 날짜(1·2·5·6: 1900년대, 3·4·7·8: 2000년대). 없는 날짜면 null.
export function birthDateOf(birth7: string): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})([1-8])$/.exec(birth7);
  if (!m) return null;
  const century = "1256".includes(m[4]) ? 1900 : 2000;
  const d = new Date(Date.UTC(century + Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}
