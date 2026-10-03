import { NextResponse } from "next/server";
import { IDENTITY_UNAVAILABLE_MESSAGE } from "./messages";
import { PortOneIdentityProvider, portOneConfigFromEnv } from "./portone";
import { FakeIdentityProvider, type IdentityProvider } from "./provider";

// 라우트가 쓰는 휴대폰 본인확인 공급자.
// - 운영: 포트원 키·필수 설정(PORTONE_API_SECRET·PORTONE_STORE_ID·PORTONE_IDENTITY_CHANNEL_KEY)이 다 있을 때만 포트원. 없으면 null.
//   라우트는 null이면 503 「본인확인 서비스 준비 중이에요」로 막는다(500으로 터지지 않게).
// - 개발·테스트: 가짜 공급자.
const globalForIdentity = globalThis as unknown as { identityProvider?: IdentityProvider };

export function identityProvider(env: NodeJS.ProcessEnv = process.env): IdentityProvider | null {
  if (env.NODE_ENV === "production") {
    const config = portOneConfigFromEnv(env);
    return config ? new PortOneIdentityProvider(config) : null;
  }
  globalForIdentity.identityProvider ??= new FakeIdentityProvider();
  return globalForIdentity.identityProvider;
}

export const identityUnavailable = () =>
  NextResponse.json({ error: "identity_unavailable", message: IDENTITY_UNAVAILABLE_MESSAGE }, { status: 503, headers: { "cache-control": "no-store" } });
