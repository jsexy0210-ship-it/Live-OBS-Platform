import { NextResponse } from "next/server";
import { AuthError } from "../authz/errors";
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

export const sessionToken = (req: Request, realm: Realm) => readCookie(req, COOKIE_NAMES[realm]);

export function setSessionCookie(res: NextResponse, realm: Realm, token: string, expires: Date) {
  res.cookies.set(COOKIE_NAMES[realm], token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export function clearSessionCookie(res: NextResponse, realm: Realm) {
  res.cookies.set(COOKIE_NAMES[realm], "", { httpOnly: true, path: "/", maxAge: 0 });
}

export function requestMeta(req: Request) {
  return {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  };
}

// 상태 변경 요청의 CSRF 차단: Origin이 있으면 요청 호스트와 같아야 한다.
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AuthError(403, "bad_origin");
  }
  if (originHost !== host) throw new AuthError(403, "bad_origin");
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

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof AuthError) return NextResponse.json({ error: e.code }, { status: e.status });
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

// 로그인 실패 사유별 상태 코드. 잠금은 429, 승인 대기·정지 등은 403.
export function loginFailureStatus(reason: string): number {
  if (reason === "locked") return 429;
  if (reason === "invalid_credentials" || reason === "mfa_required") return 401;
  if (reason === "shop_required") return 409;
  return 403;
}
