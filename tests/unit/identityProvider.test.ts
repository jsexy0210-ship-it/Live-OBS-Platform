import { afterEach, describe, expect, it, vi } from "vitest";
import { PortOneIdentityProvider } from "../../lib/server/identity/portone";
import { FAKE_REQUEST_TTL_MS, FAKE_SENT_KEEP, FakeIdentityProvider } from "../../lib/server/identity/provider";
import { newIdentityRequestId, parseIdentityPerson } from "../../lib/server/identity/verification";
import { identityProvider } from "../../lib/server/identity/registry";

describe("본인확인 공급자 고르기", () => {
  it("운영 환경(production)에서는 만들 수 없다", () => {
    expect(() => new FakeIdentityProvider("production")).toThrow(/운영 환경/);
  });

  it("개발·테스트 환경에서는 쓸 수 있다", () => {
    expect(() => new FakeIdentityProvider("test")).not.toThrow();
    expect(() => new FakeIdentityProvider("development")).not.toThrow();
  });

  it("운영 환경에서 포트원 키·필수 설정이 하나라도 없으면 공급자가 없다(라우트가 503으로 막음), 다 있으면 포트원", () => {
    const keys = { PORTONE_API_SECRET: "s", PORTONE_STORE_ID: "store-1", PORTONE_IDENTITY_CHANNEL_KEY: "channel-1" };
    expect(identityProvider({ NODE_ENV: "production" })).toBeNull();
    for (const k of Object.keys(keys)) expect(identityProvider({ NODE_ENV: "production", ...keys, [k]: " " })).toBeNull();
    expect(identityProvider({ NODE_ENV: "production", ...keys })).toBeInstanceOf(PortOneIdentityProvider);
    expect(identityProvider({ NODE_ENV: "test" })).toBeInstanceOf(FakeIdentityProvider);
  });
});

describe("포트원 휴대폰 본인확인 어댑터(실제 호출 미검증, 요청 모양·결과 대조만)", () => {
  const config = { apiSecret: "secret-value", storeId: "store-1", channelKey: "channel-1" };
  const person = { name: "홍길동", phone: "01012345678", birth7: "9505051", carrier: "KT_MVNO" as const, device: "PC" as const };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const verified = (over: Record<string, unknown> = {}) => ({
    id: "idv-1",
    status: "VERIFIED",
    channel: { key: "channel-1" },
    customData: JSON.stringify({ purpose: "BUYER_SIGNUP" }),
    verifiedCustomer: { ci: "CI", name: "홍길동", phoneNumber: "010-1234-5678", birthDate: "1995-05-05" },
    ...over,
  });

  it("인증번호 보내기는 문자 방식·채널·인적사항(7자리)·통신사·용도를 실어 보낸다", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const p = new PortOneIdentityProvider(config, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json(200, {});
    });
    expect(await p.sendCode("idv-1", "BUYER_SIGNUP", person)).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://api.portone.io/identity-verifications/idv-1/send");
    expect(calls[0].init.headers).toMatchObject({ authorization: "PortOne secret-value" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      storeId: "store-1",
      channelKey: "channel-1",
      customer: { name: "홍길동", phoneNumber: "01012345678", identityNumber: "9505051" },
      operator: "KT_MVNO",
      method: "SMS",
      customData: JSON.stringify({ purpose: "BUYER_SIGNUP" }),
      bypass: { kcpV2: { media_type: "MC01" } },
    });
    // 모바일 화면은 MC02
    await p.sendCode("idv-2", "BUYER_SIGNUP", { ...person, device: "MOBILE" });
    expect(JSON.parse(String(calls[1].init.body)).bypass).toEqual({ kcpV2: { media_type: "MC02" } });
  });

  it("[Codex P1] 대행사 요청 id는 영문·숫자만 40자 이하(hex 32자), 화면 기기는 PC·MOBILE만(없으면 MOBILE)", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newIdentityRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{1,40}$/);
    const base = { name: "홍길동", phone: "010-1234-5678", birth7: "9505051", carrier: "SKT" };
    expect(parseIdentityPerson(base)).toMatchObject({ device: "MOBILE", phone: "01012345678" });
    expect(parseIdentityPerson({ ...base, device: "PC" })).toMatchObject({ device: "PC" });
    expect(parseIdentityPerson({ ...base, device: "TABLET" })).toBeNull();
  });

  it("결과 조회: 요청 id·용도를 돌려주고, 채널·용도가 다르거나 값이 빠지면 실패, 장애·네트워크 오류는 provider_error", async () => {
    const with_ = (body: unknown, status = 200) => new PortOneIdentityProvider(config, async () => json(status, body));
    expect(await with_(verified()).fetchResult("idv-1")).toEqual({
      ok: true,
      requestId: "idv-1",
      purpose: "BUYER_SIGNUP",
      ci: "CI",
      name: "홍길동",
      phone: "01012345678",
      birthDate: new Date("1995-05-05T00:00:00Z"),
    });
    expect(await with_(verified({ channel: { key: "other" } })).fetchResult("idv-1")).toEqual({ ok: false, reason: "failed" });
    expect(await with_(verified({ customData: JSON.stringify({ purpose: "SOMETHING" }) })).fetchResult("idv-1")).toEqual({ ok: false, reason: "failed" });
    expect(await with_(verified({ customData: "not-json" })).fetchResult("idv-1")).toEqual({ ok: false, reason: "failed" });
    expect(await with_(verified({ verifiedCustomer: { ci: "CI" } })).fetchResult("idv-1")).toEqual({ ok: false, reason: "failed" });
    expect(await with_({ status: "READY" }).fetchResult("idv-1")).toEqual({ ok: false, reason: "pending" });
    expect(await with_({ status: "FAILED" }).fetchResult("idv-1")).toEqual({ ok: false, reason: "failed" });
    expect(await with_({}, 500).fetchResult("idv-1")).toEqual({ ok: false, reason: "provider_error" });
    const down = new PortOneIdentityProvider(config, async () => {
      throw new Error("ECONNRESET");
    });
    expect(await down.fetchResult("idv-1")).toEqual({ ok: false, reason: "provider_error" });
    expect(await down.confirmCode("idv-1", "123456")).toEqual({ ok: false, reason: "provider_error" });
  });

  it("[MASTER 후속] 인증번호 확인(포트원 V2 OpenAPI discriminator 값): 502 PG_PROVIDER는 wrong_code(틀린 횟수로 셈), 409 IDENTITY_VERIFICATION_ALREADY_VERIFIED는 성공, 그 밖은 장애", async () => {
    const confirm = (status: number, body: unknown) => new PortOneIdentityProvider(config, async () => json(status, body)).confirmCode("idv-1", "111111");
    expect(await confirm(502, { type: "PG_PROVIDER", message: "인증번호 불일치", pgCode: "9999", pgMessage: "OTP mismatch" })).toEqual({ ok: false, reason: "wrong_code" });
    expect(await confirm(409, { type: "IDENTITY_VERIFICATION_ALREADY_VERIFIED", message: "이미 인증 완료" })).toEqual({ ok: true });
    expect(await confirm(400, { type: "INVALID_REQUEST", message: "형식 오류" })).toEqual({ ok: false, reason: "wrong_code" });
    // 스키마 이름(옛 비교 값)은 실제 type이 아니므로 장애로 본다
    expect(await confirm(502, { type: "PgProviderError" })).toEqual({ ok: false, reason: "provider_error" });
    expect(await confirm(409, { type: "IdentityVerificationAlreadyVerifiedError" })).toEqual({ ok: false, reason: "provider_error" });
    for (const [status, type] of [[404, "IDENTITY_VERIFICATION_NOT_FOUND"], [404, "IDENTITY_VERIFICATION_NOT_SENT"], [401, "UNAUTHORIZED"], [403, "FORBIDDEN"]] as const) {
      expect(await confirm(status, { type, message: "x" })).toEqual({ ok: false, reason: "provider_error" });
    }
  });

  it("인증번호 확인: 400은 wrong_code, 그 밖의 실패는 provider_error", async () => {
    expect(await new PortOneIdentityProvider(config, async () => json(400, {})).confirmCode("idv-1", "111111")).toEqual({ ok: false, reason: "wrong_code" });
    expect(await new PortOneIdentityProvider(config, async () => json(503, {})).confirmCode("idv-1", "111111")).toEqual({ ok: false, reason: "provider_error" });
    expect(await new PortOneIdentityProvider(config, async () => json(200, {})).confirmCode("idv-1", "111111")).toEqual({ ok: true });
  });
});

describe("테스트 서버 모드의 가짜 공급자 메모리", () => {
  afterEach(() => vi.useRealTimers());
  const person = { name: "홍길동", phone: "01012345678", birth7: "9505051", carrier: "SKT" as const, device: "MOBILE" as const };

  it("1시간 지난 요청은 다음 요청 때 지우고, 보낸 기록은 최근 1000건만 남긴다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    const p = new FakeIdentityProvider("production", { testMode: true });
    for (let i = 0; i < FAKE_SENT_KEEP + 500; i++) await p.sendCode(`old-${i}`, "BUYER_SIGNUP", person);
    expect(p.sent.length).toBeLessThanOrEqual(FAKE_SENT_KEEP);
    expect(p.pendingRequestCount).toBe(FAKE_SENT_KEEP + 500);
    vi.setSystemTime(new Date(Date.now() + FAKE_REQUEST_TTL_MS + 1000));
    await p.sendCode("new", "BUYER_SIGNUP", person);
    expect(p.pendingRequestCount).toBe(1);
    // 남은 요청은 그대로 확인·조회된다
    expect(await p.confirmCode("new", "000000")).toEqual({ ok: true });
    expect((await p.fetchResult("new")).ok).toBe(true);
  });

  it("개발·시험용(테스트 서버 모드가 아님)은 지우지 않는다(시험이 보낸 기록 수를 센다)", async () => {
    vi.useFakeTimers();
    const p = new FakeIdentityProvider("test");
    await p.sendCode("a", "BUYER_SIGNUP", person);
    vi.setSystemTime(new Date(Date.now() + FAKE_REQUEST_TTL_MS + 1000));
    await p.sendCode("b", "BUYER_SIGNUP", person);
    expect(p.pendingRequestCount).toBe(2);
    expect(p.sent).toEqual(["a", "b"]);
  });
});
