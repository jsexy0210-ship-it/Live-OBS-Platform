import { afterEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("../../lib/server/db", () => ({ prisma: { $queryRaw: queryRaw } }));

const { GET } = await import("../../app/api/health/route");

afterEach(() => {
  queryRaw.mockReset();
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("DB가 응답하면 200과 배포 버전을 돌려줘요", async () => {
    vi.stubEnv("APP_VERSION", "abc1234");
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok", db: "ok", version: "abc1234" });
  });

  it("테스트 서버 모드(OBS_TEST_MODE=1)면 testMode: true를 붙이고, 아니면 붙이지 않아요", async () => {
    vi.stubEnv("APP_VERSION", "abc1234");
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    vi.stubEnv("OBS_TEST_MODE", "1");
    expect(await (await GET()).json()).toEqual({ status: "ok", db: "ok", version: "abc1234", testMode: true });
    vi.stubEnv("OBS_TEST_MODE", "0");
    expect(await (await GET()).json()).toEqual({ status: "ok", db: "ok", version: "abc1234" });
  });

  it("DB 연결이 안 되면 503이고 오류 내용은 드러내지 않아요", async () => {
    vi.stubEnv("APP_VERSION", "");
    queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=secret"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "error", db: "error", version: null });
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|5432|secret/);
  });
});
