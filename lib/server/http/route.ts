import { NextResponse } from "next/server";
import { AuthError } from "../authz/errors";
import { IMPERSONATION_COOKIE } from "../auth/impersonation";
import { COOKIE_NAMES, type Realm } from "../auth/policy";

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// 파트너스 API는 마스터 대리 조회 쿠키(lo_imp)가 있으면 그것을 먼저 본다(토큰이 「imp.」로 시작해 가드가 구분한다)
export const sessionToken = (req: Request, realm: Realm) => (realm === "seller" ? (readCookie(req, IMPERSONATION_COOKIE) ?? readCookie(req, COOKIE_NAMES.seller)) : readCookie(req, COOKIE_NAMES[realm]));

export function setSessionCookie(res: NextResponse, realm: Realm, token: string, expires: Date) {
  res.cookies.set(COOKIE_NAMES[realm], token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}

// 마스터 대리 조회 쿠키: 파트너스 API 경로에만 보낸다(관리자 화면·마스터 API에는 가지 않는다)
export function setImpersonationCookie(res: NextResponse, token: string, expires: Date) {
  res.cookies.set(IMPERSONATION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api/seller", expires });
}
export function clearImpersonationCookie(res: NextResponse) {
  res.cookies.set(IMPERSONATION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api/seller", maxAge: 0 });
}

// 짧게 쓰는 흐름용 쿠키(본인인증 소유 확인·비밀번호 재설정 권한). 지정한 경로에서만 보낸다.
export function setFlowCookie(res: NextResponse, name: string, value: string, path: string, maxAgeSeconds: number) {
  res.cookies.set(name, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path,
    maxAge: maxAgeSeconds,
  });
}

export function clearFlowCookie(res: NextResponse, name: string, path: string) {
  res.cookies.set(name, "", { httpOnly: true, path, maxAge: 0 });
}

export function clearSessionCookie(res: NextResponse, realm: Realm) {
  res.cookies.set(COOKIE_NAMES[realm], "", { httpOnly: true, path: "/", maxAge: 0 });
}

// 신뢰할 프록시 단계 수(환경변수 TRUSTED_PROXY_HOPS). 0이거나 없으면 X-Forwarded-For를 믿지 않는다.
// 접속 IP는 감사 로그 기록에만 쓴다(IP 허용 목록·제한은 두지 않음, 대표님 결정 2026-10-02).
function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? "0");
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// 접속 IP. 신뢰 프록시가 설정된 경우에만 X-Forwarded-For에서 프록시가 덧붙인 위치의 주소를 쓴다
// (맨 앞 값은 요청자가 마음대로 넣을 수 있어 쓰지 않는다). 알 수 없으면 null.
export function clientIp(req: Request): string | null {
  const hops = trustedProxyHops();
  if (hops === 0) return null;
  const list = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const ip = list[list.length - hops];
  return ip && ip.length <= 64 ? ip : null;
}

export function requestMeta(req: Request) {
  return { ip: clientIp(req), userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null };
}

// 상태 변경 요청의 CSRF 차단: Origin이 있어야 하고, 요청 호스트와 같아야 한다.
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) throw new AuthError(403, "bad_origin");
  const forwardedHost = trustedProxyHops() > 0 ? req.headers.get("x-forwarded-host") : null;
  const host = forwardedHost ?? req.headers.get("host") ?? new URL(req.url).host;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AuthError(403, "bad_origin");
  }
  if (originHost !== host) throw new AuthError(403, "bad_origin");
}

// 상태 변경 라우트(POST 등) 공통 래퍼: Origin 검사 → 처리 → 오류는 상태 코드로.
export function mutation<A extends unknown[]>(handler: (req: Request, ...args: A) => Promise<Response>) {
  return async (req: Request, ...args: A): Promise<Response> => {
    try {
      assertSameOrigin(req);
      return await handler(req, ...args);
    } catch (e) {
      // 다른 출처 403 등 오류 응답도 캐시하지 않는다
      return noStore(errorResponse(e));
    }
  };
}

export async function readJson<T>(req: Request): Promise<Partial<T>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Partial<T>) : {};
  } catch {
    return {};
  }
}

export const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

// 개인 정보가 든 응답은 브라우저·중간 캐시에 남기지 않는다(구매자 주문 조회 등)
export function noStore<T extends Response>(res: T): T {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.code }, { status: e.status });
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

// 로그인 실패 사유별 상태 코드. 승인 대기·정지 등은 403.
export function loginFailureStatus(reason: string): number {
  if (reason === "invalid_credentials") return 401;
  if (reason === "shop_required" || reason === "wrong_account_type") return 409;
  return 403;
}

// 주문대기 거부 사유별 상태 코드.
export function queueRejectionStatus(reason: string): number {
  if (reason === "not_found") return 404;
  if (reason === "invalid_timer" || reason === "reason_required" || reason === "fault_required" || reason === "invalid_refund_items") return 400;
  return 409;
}
