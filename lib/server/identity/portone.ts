import type { IdentityPerson, IdentityProvider, IdentityPurposeTag, IdentityResult, ProviderFailure } from "./provider";

// 포트원 V2 + KCP 「API 방식」 휴대폰 본인확인 어댑터(후보 구성, 2026-10-03 MASTER 조사).
// 근거: github.com/portone-io/developers.portone.io의 opi/ko/integration/pg/v2/kcp-v2-identity-verification.mdx,
// extra/identity-verification/readme-v2.mdx. 계약 전이라 실제 호출은 검증하지 않았다(키를 넣기 전 대행사 규격으로 다시 확인).
// 키 이름: PORTONE_API_SECRET, PORTONE_STORE_ID, PORTONE_IDENTITY_CHANNEL_KEY. 비밀키·인증번호는 로그·응답에 남기지 않는다.
// 서비스(용도) 대조: 요청 때 customData에 용도를 실어 보내고, 결과 조회 때 요청 id·채널·용도가 우리 기록과 같은지 본다.

export const PORTONE_ENV = ["PORTONE_API_SECRET", "PORTONE_STORE_ID", "PORTONE_IDENTITY_CHANNEL_KEY"] as const;
const BASE = "https://api.portone.io";

export type PortOneConfig = { apiSecret: string; storeId: string; channelKey: string };
type Fetch = typeof fetch;

export function portOneConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PortOneConfig | null {
  const apiSecret = env.PORTONE_API_SECRET?.trim();
  const storeId = env.PORTONE_STORE_ID?.trim();
  const channelKey = env.PORTONE_IDENTITY_CHANNEL_KEY?.trim();
  return apiSecret && storeId && channelKey ? { apiSecret, storeId, channelKey } : null;
}

const FAILURE: ProviderFailure = { ok: false, reason: "provider_error" };
const PURPOSES: readonly IdentityPurposeTag[] = ["BUYER_SIGNUP", "SELLER_REPRESENTATIVE", "PASSWORD_RESET"];

export class PortOneIdentityProvider implements IdentityProvider {
  readonly name = "portone";

  constructor(
    private readonly config: PortOneConfig,
    private readonly http: Fetch = fetch,
  ) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown } | null> {
    try {
      const res = await this.http(`${BASE}${path}`, {
        method,
        headers: { authorization: `PortOne ${this.config.apiSecret}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    } catch {
      return null;
    }
  }

  private path(requestId: string, action?: string) {
    return `/identity-verifications/${encodeURIComponent(requestId)}${action ? `/${action}` : ""}`;
  }

  async sendCode(requestId: string, purpose: IdentityPurposeTag, person: IdentityPerson) {
    const r = await this.call("POST", this.path(requestId, "send"), {
      storeId: this.config.storeId,
      channelKey: this.config.channelKey,
      customer: { name: person.name, phoneNumber: person.phone, identityNumber: person.birth7 },
      operator: person.carrier,
      method: "SMS",
      customData: JSON.stringify({ purpose }),
      // KCP API 방식 필수: 화면 기기(PC MC01, 모바일 MC02)
      bypass: { kcpV2: { media_type: person.device === "PC" ? "MC01" : "MC02" } },
    });
    return r && r.status >= 200 && r.status < 300 ? { ok: true as const } : FAILURE;
  }

  async resendCode(requestId: string) {
    const r = await this.call("POST", this.path(requestId, "resend"), { storeId: this.config.storeId });
    return r && r.status >= 200 && r.status < 300 ? { ok: true as const } : FAILURE;
  }

  async confirmCode(requestId: string, otp: string) {
    const r = await this.call("POST", this.path(requestId, "confirm"), { storeId: this.config.storeId, otp });
    if (!r) return FAILURE;
    if (r.status >= 200 && r.status < 300) return { ok: true as const };
    // 인증번호 불일치 등 사용자 입력 오류(4xx)는 wrong_code, 그 밖은 장애로 본다
    return r.status === 400 ? { ok: false as const, reason: "wrong_code" as const } : FAILURE;
  }

  async fetchResult(requestId: string): Promise<IdentityResult | ProviderFailure> {
    const r = await this.call("GET", `${this.path(requestId)}?storeId=${encodeURIComponent(this.config.storeId)}`);
    if (!r || r.status !== 200 || !r.json || typeof r.json !== "object") return FAILURE;
    const v = r.json as {
      id?: unknown;
      status?: unknown;
      channel?: { key?: unknown };
      customData?: unknown;
      verifiedCustomer?: { ci?: unknown; name?: unknown; phoneNumber?: unknown; birthDate?: unknown };
    };
    if (v.status === "READY") return { ok: false, reason: "pending" };
    if (v.status !== "VERIFIED") return { ok: false, reason: "failed" };
    let purpose: unknown;
    try {
      purpose = typeof v.customData === "string" ? (JSON.parse(v.customData) as { purpose?: unknown }).purpose : undefined;
    } catch {
      purpose = undefined;
    }
    const c = v.verifiedCustomer ?? {};
    const birthDate = typeof c.birthDate === "string" ? new Date(`${c.birthDate}T00:00:00Z`) : null;
    if (
      typeof v.id !== "string" ||
      v.channel?.key !== this.config.channelKey ||
      !PURPOSES.includes(purpose as IdentityPurposeTag) ||
      typeof c.ci !== "string" ||
      typeof c.name !== "string" ||
      typeof c.phoneNumber !== "string" ||
      !birthDate ||
      Number.isNaN(birthDate.getTime())
    ) {
      return { ok: false, reason: "failed" };
    }
    return { ok: true, requestId: v.id, purpose: purpose as IdentityPurposeTag, ci: c.ci, name: c.name, phone: c.phoneNumber.replace(/\D/g, ""), birthDate };
  }
}
