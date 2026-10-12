import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { configuredDiskAppToken, DISK_ACTIONS_REPO, DiskAppInstallationToken } from "../../lib/server/ops/diskOptimizationAppAuth";
import { diskActionsTransport, DISK_PREVIEW_WORKFLOW } from "../../lib/server/ops/diskOptimizationActions";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
const permissions = { actions: "write", contents: "read", metadata: "read" };
const at = Date.parse("2026-10-13T00:00:00.000Z"), value = "owned_installation_fixture_token_1";
function fixture() {
  let now = at;
  const install = { id: 2, app_id: 1, account: { login: DISK_ACTIONS_REPO.split("/")[0] }, repository_selection: "selected", suspended_at: null, permissions: { ...permissions } };
  const issued: Record<string, unknown> = { token: value, expires_at: new Date(now + 3_600_000).toISOString(), permissions: { ...permissions }, repositories: [{ full_name: DISK_ACTIONS_REPO }] };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe("error"); expect(init.cache).toBe("no-store");
    if (url === `https://api.github.com/repos/${DISK_ACTIONS_REPO}/installation`) {
      const jwt = (init.headers as Record<string, string>).authorization.slice(7).split(".");
      expect(JSON.parse(Buffer.from(jwt[0], "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
      expect(JSON.parse(Buffer.from(jwt[1], "base64url").toString())).toEqual({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: "1" });
      expect(verify("RSA-SHA256", Buffer.from(jwt.slice(0, 2).join(".")), keys.publicKey, Buffer.from(jwt[2], "base64url"))).toBe(true);
      return Response.json(install);
    }
    expect(url).toBe("https://api.github.com/app/installations/2/access_tokens");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ repositories: ["Live-OBS-Platform"], permissions: { actions: "write", contents: "read" } });
    return Response.json(issued, { status: 201 });
  });
  vi.stubGlobal("fetch", fetch);
  return { install, issued, fetch, source: new DiskAppInstallationToken("1", "2", pem, () => now), setTime: (time: number) => { now = time; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("preview 전용 App 설치 자격", () => {
  it("구형과 긴 JWT형·짧은 dot형 설치 토큰을 해석 없이 헤더와 캐시에 보존한다", async () => {
    for (const token of ["ghs_" + "a".repeat(36), "ghs_1_" + "a".repeat(170) + "." + "b".repeat(170) + "." + "c".repeat(180), "ghs_1_" + "a".repeat(12) + "." + "b".repeat(12) + "." + "c".repeat(12)]) {
      const f = fixture(), original = f.fetch.getMockImplementation()!;
      f.issued.token = token;
      f.fetch.mockImplementation(async (url, init) => {
        if (url.includes("/actions/")) {
          expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
          return Response.json({ workflow_runs: [] });
        }
        return original(url, init);
      });
      expect(await f.source.token()).toBe(token);
      await diskActionsTransport(f.source)("GET", `/repos/${DISK_ACTIONS_REPO}/actions/workflows/${DISK_PREVIEW_WORKFLOW}/runs?branch=main&event=workflow_dispatch&per_page=100`);
      expect(await f.source.token()).toBe(token); expect(f.fetch).toHaveBeenCalledTimes(3);
    }
  });
  it("설치 토큰의 헤더 주입·공백·비ASCII·과도한 크기는 workflow 요청 전에 거부한다", async () => {
    for (const token of ["a".repeat(19), "a".repeat(4097), value + "\r\nother: owned", value + "\n", value + " ", value + "\x7f", value + "한"]) {
      const f = fixture(); f.issued.token = token;
      await expect(diskActionsTransport(f.source)("POST", `/repos/${DISK_ACTIONS_REPO}/actions/workflows/${DISK_PREVIEW_WORKFLOW}/dispatches`, { ref: "main" })).rejects.toThrow("ACTIONS_APP_AUTH_UNAVAILABLE");
      expect(f.fetch).toHaveBeenCalledTimes(2);
    }
  });
  it("서명·정확 설치·축소 권한과 repo1개를 검증하고 토큰을 동시 요청에 한 번만 발급한다", async () => {
    const f = fixture();
    expect(await Promise.all([f.source.token(), f.source.token()])).toEqual([value, value]);
    expect(await f.source.token()).toBe(value);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("만료60초 전에는 새 토큰을 발급하고 실패 시 기존 만료 토큰을 사용하지 않는다", async () => {
    const f = fixture(); await f.source.token();
    f.setTime(at + 3_540_000); f.issued.token = "owned_installation_fixture_token_2"; f.issued.expires_at = new Date(at + 7_140_000).toISOString();
    expect(await f.source.token()).toBe(f.issued.token); expect(f.fetch).toHaveBeenCalledTimes(4);
    f.setTime(at + 7_080_000); f.fetch.mockRejectedValue(new Error("owned secret must not escape"));
    await expect(f.source.token()).rejects.toThrow("ACTIONS_APP_AUTH_UNAVAILABLE");
  });
  it("다른 App·설치·계정·전체repo·정지·추가권한은 토큰 발급 전에 거부한다", async () => {
    for (const delta of [{ id: 3 }, { app_id: 3 }, { account: { login: "other" } }, { repository_selection: "all" }, { suspended_at: "2026-10-13" }, { permissions: { ...permissions, contents: "write" } }, { permissions: { ...permissions, administration: "read" } }]) {
      const f = fixture(); Object.assign(f.install, delta);
      await expect(f.source.token()).rejects.toThrow("ACTIONS_APP_AUTH_UNAVAILABLE");
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("응답repo 확대·권한확대·만료·과도한TTL·잘못된 응답은 실패하며 값을 오류에 싣지 않는다", async () => {
    for (const delta of [{ repositories: [{ full_name: "other/repo" }] }, { repositories: [{ full_name: DISK_ACTIONS_REPO }, { full_name: "other/repo" }] }, { permissions: { ...permissions, contents: "write" } }, { expires_at: new Date(at).toISOString() }, { expires_at: new Date(at + 7_200_000).toISOString() }, { token: "" }]) {
      const f = fixture(); Object.assign(f.issued, delta);
      await expect(f.source.token()).rejects.toThrow("ACTIONS_APP_AUTH_UNAVAILABLE");
    }
  });
  it("실 Actions 인증 실패를 재POST하지 않고 다음 조회의 자격만 다시 발급한다", async () => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    let posts = 0;
    f.fetch.mockImplementation(async (url, init) => {
      if (url.includes("/actions/")) { posts += init.method === "POST" ? 1 : 0; return Response.json({ error: "owned" }, { status: 401 }); }
      return original(url, init);
    });
    const transport = diskActionsTransport(f.source), path = `/repos/${DISK_ACTIONS_REPO}/actions/workflows/${DISK_PREVIEW_WORKFLOW}/dispatches`;
    expect((await transport("POST", path, { ref: "main" })).status).toBe(401);
    expect(posts).toBe(1); expect(f.fetch).toHaveBeenCalledTimes(3);
    await f.source.token(); expect(f.fetch).toHaveBeenCalledTimes(5); expect(posts).toBe(1);
  });
  it("발급 오류나 해석 불가 응답은 workflow POST0이다", async () => {
    const f = fixture(); f.fetch.mockResolvedValue(Response.json({ error: "private details" }, { status: 403 }));
    await expect(diskActionsTransport(f.source)("POST", `/repos/${DISK_ACTIONS_REPO}/actions/workflows/${DISK_PREVIEW_WORKFLOW}/dispatches`, { ref: "main" })).rejects.toThrow("ACTIONS_APP_AUTH_UNAVAILABLE");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("부분설정/잘못된키는 null이며 키 회전은 새 issuer로 이전 토큰 캐시를 배제한다", () => {
    vi.stubEnv("ONQ_DISK_APP_ID", "1"); vi.stubEnv("ONQ_DISK_INSTALLATION_ID", "2"); vi.stubEnv("ONQ_DISK_APP_PRIVATE_KEY_BASE64", "");
    expect(configuredDiskAppToken()).toBeNull();
    vi.stubEnv("ONQ_DISK_APP_PRIVATE_KEY_BASE64", pem);
    const first = configuredDiskAppToken(); expect(first).not.toBeNull(); expect(configuredDiskAppToken()).toBe(first);
    const next = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    vi.stubEnv("ONQ_DISK_APP_PRIVATE_KEY_BASE64", Buffer.from(next).toString("base64"));
    expect(configuredDiskAppToken()).not.toBe(first);
    vi.stubEnv("ONQ_DISK_APP_PRIVATE_KEY_BASE64", "not-a-private-key"); expect(configuredDiskAppToken()).toBeNull();
  });
});
