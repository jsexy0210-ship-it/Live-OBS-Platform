import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { allowedRequestHost } from "../../lib/infra/host-policy";
import { proxy } from "../../proxy";

const domain = "on-aircue.com";
afterEach(() => vi.unstubAllEnvs());

describe("obs-test 허용 호스트", () => {
  it.each([domain, "ON-AIRCUE.COM", `${domain}:443`, `${domain}:80`])("루트 도메인 허용: %s", (host) => {
    expect(allowedRequestHost(host, "/seller/login", "GET", domain)).toBe(true);
  });
  it.each(["www.on-aircue.com", "live-obs-test.duckdns.org", "attacker.test", "on-aircue.com.attacker.test",
    "on-aircue.com@attacker.test", "on-aircue.com,attacker.test", "on-aircue.com:3000",
    " on-aircue.com", "on-aircue.com.", "https://on-aircue.com", null])("미허용/변조 Host 거부: %s", (host) => {
    expect(allowedRequestHost(host, "/seller/login", "GET", domain)).toBe(false);
  });
  it("서버 내부 health 이외에는 루프백으로 우회할 수 없다", () => {
    expect(allowedRequestHost("127.0.0.1:3000", "/api/health", "GET", domain)).toBe(true);
    expect(allowedRequestHost("127.0.0.1:3000", "/api/live", "HEAD", domain)).toBe(true);
    expect(allowedRequestHost("127.0.0.1:3000", "/seller/login", "GET", domain)).toBe(false);
    expect(allowedRequestHost("127.0.0.1:3000", "/api/health", "POST", domain)).toBe(false);
  });
  it("설정 누락 또는 와일드카드는 거부한다", () => {
    for (const invalid of [undefined, "", "*", "*.on-aircue.com", "on-aircue.com,"]) {
      expect(allowedRequestHost(domain, "/", "GET", invalid)).toBe(false);
    }
  });
  it("프록시는 X-Forwarded-Host 위조로 실제 Host 검증을 우회하지 않는다", () => {
    vi.stubEnv("OBS_ENFORCE_HOST_POLICY", "1");
    vi.stubEnv("OBS_ALLOWED_HOSTS", domain);
    const req = new NextRequest("https://attacker.test/", { headers: { host: "attacker.test", "x-forwarded-host": domain } });
    const res = proxy(req);
    expect(res.status).toBe(421);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("obs-test 정책이 설정되지 않은 개발 환경은 기존 동작 유지", () => {
    vi.stubEnv("OBS_ENFORCE_HOST_POLICY", "");
    expect(proxy(new NextRequest("http://localhost:3000/" )).headers.get("x-middleware-next")).toBe("1");
  });
});
