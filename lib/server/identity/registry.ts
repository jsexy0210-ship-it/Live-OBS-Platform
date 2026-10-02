import { FakeIdentityProvider, type IdentityProvider } from "./provider";

// 라우트가 쓰는 본인인증 공급자. 실제 PASS 대행사 연동 전이라 운영에서는 쓸 수 있는 공급자가 없다(호출하면 오류).
const globalForIdentity = globalThis as unknown as { identityProvider?: IdentityProvider };

export function identityProvider(): IdentityProvider {
  if (process.env.NODE_ENV === "production") {
    throw new Error("운영 본인인증 공급자가 아직 연결되지 않았어요.");
  }
  globalForIdentity.identityProvider ??= new FakeIdentityProvider();
  return globalForIdentity.identityProvider;
}
