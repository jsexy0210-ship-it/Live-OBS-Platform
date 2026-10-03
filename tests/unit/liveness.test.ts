import { afterEach, expect, it, vi } from "vitest";
import { GET } from "../../app/api/live/route";

afterEach(() => vi.unstubAllEnvs());

it("생존 확인은 버전만 반환하고 캐시하지 않는다", async () => {
  vi.stubEnv("APP_VERSION", "test-sha");
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ok", version: "test-sha" });
});
