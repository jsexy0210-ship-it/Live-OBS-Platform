import { describe, expect, it } from "vitest";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { identityProvider } from "../../lib/server/identity/registry";

describe("가짜 본인인증 공급자", () => {
  it("운영 환경(production)에서는 만들 수 없다", () => {
    expect(() => new FakeIdentityProvider("production")).toThrow(/운영 환경/);
  });

  it("개발·테스트 환경에서는 쓸 수 있다", () => {
    expect(() => new FakeIdentityProvider("test")).not.toThrow();
    expect(() => new FakeIdentityProvider("development")).not.toThrow();
  });

  it("라우트용 공급자는 운영 환경에서 쓸 수 없다(실제 PASS 연동 전)", () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      expect(() => identityProvider()).toThrow(/운영 본인인증 공급자/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    }
  });
});
