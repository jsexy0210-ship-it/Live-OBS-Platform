import { describe, expect, it } from "vitest";
import { PortOneIdentityProvider } from "../../lib/server/identity/portone";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
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

  it("인증번호 확인: 400은 wrong_code, 그 밖의 실패는 provider_error", async () => {
    expect(await new PortOneIdentityProvider(config, async () => json(400, {})).confirmCode("idv-1", "111111")).toEqual({ ok: false, reason: "wrong_code" });
    expect(await new PortOneIdentityProvider(config, async () => json(503, {})).confirmCode("idv-1", "111111")).toEqual({ ok: false, reason: "provider_error" });
    expect(await new PortOneIdentityProvider(config, async () => json(200, {})).confirmCode("idv-1", "111111")).toEqual({ ok: true });
  });
});
