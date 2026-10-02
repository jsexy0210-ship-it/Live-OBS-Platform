// 판매자 가입 자동 점검에 쓰는 사업자 확인(대표님 결정 2026-10-02, PRODUCT_SCOPE 「판매자 가입 자동 승인」).
// 국세청 사업자 상태 조회는 공급자 인터페이스로만 부른다. 실제 조회(공공데이터포털 API 키 필요) 연결 전에는 가짜 공급자뿐이다.

export type BusinessStatus = "ACTIVE" | "SUSPENDED" | "CLOSED" | "NOT_FOUND";
export type BusinessLookup = { ok: true; status: BusinessStatus } | { ok: false; reason: "lookup_failed" };

export interface BusinessStatusProvider {
  readonly name: string;
  // 사업자등록번호(숫자 10자리)의 상태. ACTIVE = 국세청 「계속사업자」.
  lookup(businessNumber: string): Promise<BusinessLookup>;
}

export class FakeBusinessStatusProvider implements BusinessStatusProvider {
  readonly name = "fake";
  private statuses = new Map<string, BusinessStatus>();
  private failing = new Set<string>();

  // 운영 환경에서는 만들 수 없다(가짜 조회로 자동 승인되는 것을 막는다).
  constructor(env: string | undefined = process.env.NODE_ENV) {
    if (env === "production") throw new Error("운영 환경에서는 가짜 사업자 조회를 쓸 수 없어요.");
  }

  set(businessNumber: string, status: BusinessStatus) {
    this.statuses.set(businessNumber, status);
  }

  fail(businessNumber: string) {
    this.failing.add(businessNumber);
  }

  async lookup(businessNumber: string): Promise<BusinessLookup> {
    if (this.failing.has(businessNumber)) return { ok: false, reason: "lookup_failed" };
    return { ok: true, status: this.statuses.get(businessNumber) ?? "ACTIVE" };
  }
}

const globalForBusiness = globalThis as unknown as { businessStatusProvider?: BusinessStatusProvider };

// 라우트가 쓰는 사업자 조회 공급자. 실제 연동 전이라 운영에서는 쓸 수 있는 공급자가 없다(호출하면 오류).
export function businessStatusProvider(): BusinessStatusProvider {
  if (process.env.NODE_ENV === "production") throw new Error("운영 사업자 상태 조회가 아직 연결되지 않았어요.");
  globalForBusiness.businessStatusProvider ??= new FakeBusinessStatusProvider();
  return globalForBusiness.businessStatusProvider;
}

// 사업자등록번호: 숫자만 남겨 10자리, 국세청 검증 숫자 규칙. 틀리면 null.
export function normalizeBusinessNumber(raw: string): string | null {
  const d = raw.replace(/[\s-]/g, "");
  if (!/^\d{10}$/.test(d)) return null;
  const n = Array.from(d, Number);
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = w.reduce((acc, wi, i) => acc + n[i] * wi, 0);
  sum += Math.floor((n[8] * 5) / 10);
  return (10 - (sum % 10)) % 10 === n[9] ? d : null;
}

// 통신판매업 신고번호: 「제2024-서울강남-01234호」 형식(제·호, 공백은 있어도 되고 없어도 됨). 맞으면 표준 형태, 틀리면 null.
export function normalizeMailOrderNumber(raw: string): string | null {
  const m = raw.replace(/\s/g, "").match(/^제?(\d{4})-([가-힣A-Za-z0-9]{2,20})-(\d{3,6})호?$/);
  return m ? `제${m[1]}-${m[2]}-${m[3]}호` : null;
}
