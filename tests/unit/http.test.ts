import { afterEach, describe, expect, it } from "vitest";
import { assertSameOrigin, clientIp } from "../../lib/server/http/route";

const req = (headers: Record<string, string>) => new Request("http://shop.example/api/x", { method: "POST", headers });

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

describe("접속 IP (신뢰 프록시)", () => {
  it("신뢰 프록시를 설정하지 않으면 X-Forwarded-For를 믿지 않는다", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
  });

  it("프록시 1단계면 프록시가 덧붙인 마지막 값을 쓰고, 요청자가 넣은 앞 값은 무시한다", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("프록시 2단계면 뒤에서 두 번째 값을 쓴다", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    expect(clientIp(req({ "x-forwarded-for": "10.0.0.1" }))).toBeNull();
  });
});

describe("Origin 검사 (CSRF)", () => {
  it("같은 호스트면 통과", () => {
    expect(() => assertSameOrigin(req({ origin: "http://shop.example", host: "shop.example" }))).not.toThrow();
  });

  it("Origin이 없거나 다르면 거부", () => {
    expect(() => assertSameOrigin(req({ host: "shop.example" }))).toThrow("bad_origin");
    expect(() => assertSameOrigin(req({ origin: "https://evil.example", host: "shop.example" }))).toThrow("bad_origin");
  });

  it("신뢰 프록시가 없으면 X-Forwarded-Host를 믿지 않는다", () => {
    expect(() =>
      assertSameOrigin(req({ origin: "https://evil.example", host: "shop.example", "x-forwarded-host": "evil.example" })),
    ).toThrow("bad_origin");
  });
});
