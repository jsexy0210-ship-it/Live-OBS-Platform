// 판매자 가입 자동 점검에 쓰는 사업자 확인(대표님 결정 2026-10-02, PRODUCT_SCOPE 「판매자 가입 자동 승인」).
// - 국세청 「사업자등록정보 진위확인 및 상태조회」: 사업자번호·대표자명(휴대폰 본인확인 이름)·개업일자 대조(진위확인)와 상태(계속사업자) 확인.
//   키 NTS_BUSINESS_STATUS_API_KEY. BUSINESS_STATUS_PROVIDER=fake를 명시했을 때만 가짜.
// - 공정위 「통신판매사업자 등록상세」: 신고번호 등록·사업자번호 일치·영업 상태 조회. 키 FTC_MAIL_ORDER_API_KEY. MAIL_ORDER_PROVIDER=fake를 명시했을 때만 가짜.
// 실제 연동 전이거나 키가 없으면 조회 실패로 처리해 자동 승인하지 않는다(MASTER 결정 2026-10-03). 키 값은 저장소에 두지 않는다.

export type BusinessStatus = "ACTIVE" | "SUSPENDED" | "CLOSED" | "NOT_FOUND";
// valid: 사업자번호·대표자명·개업일자가 국세청 등록 정보와 일치하는지
export type BusinessVerify = { ok: true; valid: boolean; status: BusinessStatus } | { ok: false; reason: "lookup_failed" };
export type BusinessVerifyInput = { businessNumber: string; representativeName: string; openedOn: string };

export interface BusinessStatusProvider {
  readonly name: string;
  verify(input: BusinessVerifyInput): Promise<BusinessVerify>;
}

type BusinessRecord = { representativeName: string; openedOn: string; status: BusinessStatus };

export class FakeBusinessStatusProvider implements BusinessStatusProvider {
  readonly name = "fake";
  private records = new Map<string, BusinessRecord>();
  private failing = new Set<string>();

  // 운영 환경에서는 만들 수 없다(가짜 조회로 자동 승인되는 것을 막는다).
  constructor(env: string | undefined = process.env.NODE_ENV) {
    if (env === "production") throw new Error("운영 환경에서는 가짜 사업자 조회를 쓸 수 없어요.");
  }

  // 테스트에서 국세청 등록 정보를 정한다. 등록하지 않은 번호는 입력과 일치하는 계속사업자로 본다.
  register(businessNumber: string, record: Partial<BusinessRecord> & { representativeName: string }) {
    this.records.set(businessNumber, { openedOn: "20200101", status: "ACTIVE", ...record });
  }

  set(businessNumber: string, status: BusinessStatus) {
    const prev = this.records.get(businessNumber);
    if (prev) prev.status = status;
    else this.statuses.set(businessNumber, status);
  }
  private statuses = new Map<string, BusinessStatus>();

  fail(businessNumber: string) {
    this.failing.add(businessNumber);
  }

  async verify(input: BusinessVerifyInput): Promise<BusinessVerify> {
    if (this.failing.has(input.businessNumber)) return { ok: false, reason: "lookup_failed" };
    const r = this.records.get(input.businessNumber);
    if (!r) return { ok: true, valid: true, status: this.statuses.get(input.businessNumber) ?? "ACTIVE" };
    return { ok: true, valid: r.representativeName === input.representativeName && r.openedOn === input.openedOn, status: r.status };
  }
}

// 조회 키가 없거나 실제 연동 전이면 모든 조회를 「조회 실패」로 돌려준다 → 자동 승인하지 않고 「확인 필요」로 간다.
export class UnavailableBusinessStatusProvider implements BusinessStatusProvider {
  readonly name = "unavailable";
  async verify(): Promise<BusinessVerify> {
    return { ok: false, reason: "lookup_failed" };
  }
}

const globalForBusiness = globalThis as unknown as { businessStatusProvider?: BusinessStatusProvider; mailOrderProvider?: MailOrderProvider };

// 라우트가 쓰는 국세청 조회 공급자. 실제 조회는 아직 연동 전이라 fake가 아니면 조회 실패로 처리한다.
export function businessStatusProvider(): BusinessStatusProvider {
  if (process.env.BUSINESS_STATUS_PROVIDER === "fake") {
    globalForBusiness.businessStatusProvider ??= new FakeBusinessStatusProvider();
    return globalForBusiness.businessStatusProvider;
  }
  return new UnavailableBusinessStatusProvider();
}

// ───────────── 통신판매업 신고 조회(공정위) ─────────────

export type MailOrderStatus = "NORMAL" | "SUSPENDED" | "CLOSED";
// 이 사업자번호로 등록된 신고 가운데 신청한 신고번호와 같은 것(없으면 null)
export type MailOrderLookup =
  | { ok: true; record: { mailOrderNumber: string; businessNumber: string; status: MailOrderStatus } | null }
  | { ok: false; reason: "lookup_failed" };

export interface MailOrderProvider {
  readonly name: string;
  lookup(input: { businessNumber: string; mailOrderNumber: string }): Promise<MailOrderLookup>;
}

export class FakeMailOrderProvider implements MailOrderProvider {
  readonly name = "fake";
  private records = new Map<string, { mailOrderNumber: string; businessNumber: string; status: MailOrderStatus } | null>();
  private failing = new Set<string>();

  constructor(env: string | undefined = process.env.NODE_ENV) {
    if (env === "production") throw new Error("운영 환경에서는 가짜 통신판매업 조회를 쓸 수 없어요.");
  }

  // 테스트에서 신고번호의 등록 정보를 정한다(null = 등록 없음). 정하지 않은 번호는 그 사업자번호로 정상 등록된 것으로 본다.
  register(mailOrderNumber: string, record: { businessNumber: string; status?: MailOrderStatus } | null) {
    this.records.set(mailOrderNumber, record ? { mailOrderNumber, status: "NORMAL", ...record } : null);
  }

  fail(mailOrderNumber: string) {
    this.failing.add(mailOrderNumber);
  }

  async lookup(input: { businessNumber: string; mailOrderNumber: string }): Promise<MailOrderLookup> {
    if (this.failing.has(input.mailOrderNumber)) return { ok: false, reason: "lookup_failed" };
    if (!this.records.has(input.mailOrderNumber)) {
      return { ok: true, record: { mailOrderNumber: input.mailOrderNumber, businessNumber: input.businessNumber, status: "NORMAL" } };
    }
    return { ok: true, record: this.records.get(input.mailOrderNumber) ?? null };
  }
}

export class UnavailableMailOrderProvider implements MailOrderProvider {
  readonly name = "unavailable";
  async lookup(): Promise<MailOrderLookup> {
    return { ok: false, reason: "lookup_failed" };
  }
}

export function mailOrderProvider(): MailOrderProvider {
  if (process.env.MAIL_ORDER_PROVIDER === "fake") {
    globalForBusiness.mailOrderProvider ??= new FakeMailOrderProvider();
    return globalForBusiness.mailOrderProvider;
  }
  return new UnavailableMailOrderProvider();
}

// 개업일자: YYYYMMDD 또는 YYYY-MM-DD → YYYYMMDD(실제 있는 날짜만). 틀리면 null.
export function normalizeOpenedOn(raw: string): string | null {
  const d = raw.replace(/[\s.-]/g, "");
  if (!/^\d{8}$/.test(d)) return null;
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day || y < 1900) return null;
  return d;
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
