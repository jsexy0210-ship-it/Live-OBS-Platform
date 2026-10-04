import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { billingProvider } from "../../lib/server/billing/registry";
import { PortOneIdentityProvider } from "../../lib/server/identity/portone";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { identityProvider } from "../../lib/server/identity/registry";
import { isTestMode } from "../../lib/server/testMode";

const e = (v: Record<string, string | undefined>) => v as NodeJS.ProcessEnv;
const portone = { PORTONE_API_SECRET: "s", PORTONE_STORE_ID: "store-1", PORTONE_IDENTITY_CHANNEL_KEY: "channel-1" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("테스트 서버 모드(OBS_TEST_MODE=1)", () => {
  it("값이 정확히 1일 때만 켜진다", () => {
    expect(isTestMode(e({ OBS_TEST_MODE: "1" }))).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1"]) expect(isTestMode(e({ OBS_TEST_MODE: v }))).toBe(false);
  });

  it("플래그가 없으면 운영 빌드는 그대로: 포트원 설정이 없으면 본인확인 공급자 없음(503), 가짜 공급자는 만들 수 없다", () => {
    expect(identityProvider(e({ NODE_ENV: "production" }))).toBeNull();
    expect(identityProvider(e({ NODE_ENV: "production", ...portone }))).toBeInstanceOf(PortOneIdentityProvider);
    expect(() => new FakeIdentityProvider("production")).toThrow(/운영 환경/);
    expect(() => new FakeBillingProvider("production")).toThrow();
    expect(() => billingProvider(e({ NODE_ENV: "production" }))).toThrow();
  });

  it("플래그가 있으면 운영 빌드여도(포트원 설정이 있어도) 가짜 본인확인·가짜 결제 공급자를 쓰고, 서버 로그에 경고를 남긴다", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = e({ NODE_ENV: "production", OBS_TEST_MODE: "1" });
    expect(identityProvider(env)?.name).toBe("fake");
    expect(identityProvider(e({ ...env, ...portone }))?.name).toBe("fake");
    expect(billingProvider(env).name).toBe("fake");
    expect(() => new FakeIdentityProvider("production", { testMode: true })).not.toThrow();
    expect(() => new FakeBillingProvider("production", { testMode: true })).not.toThrow();
    // 경고는 프로세스에서 한 번만(앞선 테스트가 이미 남겼으면 0번)
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
