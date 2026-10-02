import { describe, expect, it } from "vitest";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

describe("assertTestDatabaseUrl", () => {
  it("_test로 끝나는 DB는 통과", () => {
    const url = "postgresql://u:p@localhost:5432/live_obs_test";
    expect(assertTestDatabaseUrl(url)).toBe(url);
  });

  it("주소가 없으면 거부", () => {
    expect(() => assertTestDatabaseUrl(undefined)).toThrow();
  });

  it("_test가 아닌 DB는 거부", () => {
    expect(() => assertTestDatabaseUrl("postgresql://u:p@db.example.com:5432/live_obs")).toThrow(/테스트 DB가 아니에요/);
    expect(() => assertTestDatabaseUrl("postgresql://u:p@localhost:5432/live_obs_test_backup")).toThrow();
  });

  it("형식이 틀리면 거부", () => {
    expect(() => assertTestDatabaseUrl("not a url")).toThrow();
  });
});
