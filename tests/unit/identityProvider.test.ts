import { describe, expect, it } from "vitest";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";

describe("가짜 본인인증 공급자", () => {
  it("운영 환경(production)에서는 만들 수 없다", () => {
    expect(() => new FakeIdentityProvider("production")).toThrow(/운영 환경/);
  });

  it("개발·테스트 환경에서는 쓸 수 있다", () => {
    expect(() => new FakeIdentityProvider("test")).not.toThrow();
    expect(() => new FakeIdentityProvider("development")).not.toThrow();
  });
});
