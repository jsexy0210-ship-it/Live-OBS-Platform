import { NextResponse } from "next/server";
import { IDENTITY_UNAVAILABLE_MESSAGE } from "./messages";
import { PortOneIdentityProvider, portOneConfigFromEnv } from "./portone";
import { isTestMode, warnTestModeOnce } from "../testMode";
import { FakeIdentityProvider, type IdentityProvider } from "./provider";

// 라우트가 쓰는 휴대폰 본인확인 공급자.
// - 운영: 포트원 키·필수 설정(PORTONE_API_SECRET·PORTONE_STORE_ID·PORTONE_IDENTITY_CHANNEL_KEY)이 다 있을 때만 포트원. 없으면 null.
//   라우트는 null이면 503 「본인확인 서비스 준비 중이에요」로 막는다(500으로 터지지 않게).
// - 개발·테스트: 가짜 공급자.
// - 테스트 서버(OBS_TEST_MODE=1, testMode.ts): 운영 빌드여도, 포트원 설정이 있어도 가짜 공급자를 쓴다(인증번호 000000, 문자·과금 없음).
const globalForIdentity = globalThis as unknown as { identityProvider?: IdentityProvider };

export function identityProvider(env: NodeJS.ProcessEnv = process.env): IdentityProvider | null {
  if (isTestMode(env)) {
    warnTestModeOnce();
    globalForIdentity.identityProvider ??= new FakeIdentityProvider(env.NODE_ENV, { testMode: true });
    return globalForIdentity.identityProvider;
  }
  if (env.NODE_ENV === "production") {
    const config = portOneConfigFromEnv(env);
    return config ? new PortOneIdentityProvider(config) : null;
  }
  globalForIdentity.identityProvider ??= new FakeIdentityProvider();
  return globalForIdentity.identityProvider;
}

export const identityUnavailable = () =>
  NextResponse.json({ error: "identity_unavailable", message: IDENTITY_UNAVAILABLE_MESSAGE }, { status: 503, headers: { "cache-control": "no-store" } });
