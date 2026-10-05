import { externalConfig, type ExternalConfig } from "./config";

// 외부 쇼핑몰 OAuth 공급자 계약. 실제 호출은 호스트를 검증한 몰 id로만 만든다(주소를 받아 접속하지 않는다 = 내부 주소 접속 차단).
export type TokenSet = { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date | null; scopes: string | null };
// 쇼핑몰이 준 HTTP 상태(응답 본문은 싣지 않는다). 400·401은 토큰이 이미 무효라는 뜻이라 다시 연결해야 한다.
export class ExternalHttpError extends Error {
  constructor(readonly status: number) {
    super(`token_http_${status}`);
  }
}

export interface ExternalShopProvider {
  authorizeUrl(shopKey: string, state: string): string;
  exchangeCode(shopKey: string, code: string): Promise<TokenSet>;
  refresh(shopKey: string, refreshToken: string): Promise<TokenSet>;
  // ok: 철회됨(이미 무효 포함), retry: 시간 초과·5xx 등 다시 시도해야 함
  revoke(shopKey: string, token: string): Promise<"ok" | "retry">;
}

const SHOP_KEY = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const isShopKey = (v: unknown): v is string => typeof v === "string" && SHOP_KEY.test(v);

// 판매자가 낸 주소에서 몰 id만 뽑는다. https, 기본 포트, 지원 도메인(<몰 id>.<지원 도메인>)만. 그 밖(IP·localhost·사용자 정의 도메인)은 null.
const SUPPORTED_HOST = /^([a-z0-9][a-z0-9-]{1,40})\.(cafe24\.com|cafe24shop\.com)$/;
export function shopKeyOf(shopUrl: unknown): string | null {
  if (typeof shopUrl !== "string" || shopUrl.length > 300) return null;
  let u: URL;
  try {
    u = new URL(shopUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return null;
  return SUPPORTED_HOST.exec(u.hostname.toLowerCase())?.[1] ?? null;
}

const TIMEOUT_MS = 10_000;

// 실제 공급자. 엔드포인트 경로는 공식 문서 직접 확인 전 값이다(「미검증」). 호출 실패 때 응답 본문은 오류에 싣지 않는다(토큰·개인정보 유입 방지).
export class HttpExternalProvider implements ExternalShopProvider {
  constructor(private readonly cfg: ExternalConfig) {}
  private base = (shopKey: string) => {
    if (!isShopKey(shopKey)) throw new Error("bad_shop_key");
    return `https://${shopKey}.cafe24api.com/api/v2/oauth`;
  };
  authorizeUrl(shopKey: string, state: string): string {
    const q = new URLSearchParams({ response_type: "code", client_id: this.cfg.clientId, state, redirect_uri: this.cfg.redirectUri, scope: this.cfg.scopes });
    return `${this.base(shopKey)}/authorize?${q}`;
  }
  private async token(shopKey: string, form: Record<string, string>): Promise<TokenSet> {
    const res = await fetch(`${this.base(shopKey)}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) throw new ExternalHttpError(res.status);
    const b = (await res.json()) as { access_token?: string; refresh_token?: string; expires_at?: string; refresh_token_expires_at?: string; scopes?: string[] | string };
    if (!b.access_token || !b.refresh_token) throw new Error("token_bad_response");
    const exp = b.expires_at ? new Date(b.expires_at) : new Date(Date.now() + 2 * 3600_000);
    const rexp = b.refresh_token_expires_at ? new Date(b.refresh_token_expires_at) : null;
    return {
      accessToken: b.access_token,
      refreshToken: b.refresh_token,
      accessExpiresAt: Number.isNaN(exp.getTime()) ? new Date(Date.now() + 2 * 3600_000) : exp,
      refreshExpiresAt: rexp && !Number.isNaN(rexp.getTime()) ? rexp : null,
      scopes: Array.isArray(b.scopes) ? b.scopes.join(",") : (b.scopes ?? null),
    };
  }
  exchangeCode(shopKey: string, code: string) {
    return this.token(shopKey, { grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri });
  }
  refresh(shopKey: string, refreshToken: string) {
    return this.token(shopKey, { grant_type: "refresh_token", refresh_token: refreshToken });
  }
  async revoke(shopKey: string, token: string): Promise<"ok" | "retry"> {
    try {
      const res = await fetch(`${this.base(shopKey)}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}` },
        body: new URLSearchParams({ token, token_type_hint: "refresh_token" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
      // 4xx(이미 무효·권한 없음)는 다시 시도해도 같다: 철회된 것으로 본다. 429·5xx는 다시 시도
      return res.status === 429 || res.status >= 500 ? "retry" : "ok";
    } catch {
      return "retry";
    }
  }
}

// 설정 키가 없으면 null(연동 꺼짐)
export function externalProvider(env: Record<string, string | undefined> = process.env): ExternalShopProvider | null {
  const cfg = externalConfig(env);
  return cfg.enabled ? new HttpExternalProvider(cfg) : null;
}
