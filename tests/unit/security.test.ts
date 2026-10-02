import { describe, expect, it } from "vitest";
import { redact } from "../../lib/server/audit/log";
import { hashPassword, verifyPassword } from "../../lib/server/auth/password";
import { generateToken, hashToken } from "../../lib/server/auth/token";

describe("비밀번호 해시 (argon2id)", () => {
  it("argon2id로 저장하고 맞는 비밀번호만 통과", async () => {
    const h = await hashPassword("correct horse");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "correct horse")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});

describe("세션 토큰", () => {
  it("256비트 무작위 토큰, 저장은 SHA-256 해시", () => {
    const t = generateToken();
    expect(Buffer.from(t, "base64url").length).toBe(32);
    expect(generateToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });
});

describe("감사 로그 비밀값 제거", () => {
  it("비밀번호 해시·토큰은 지운다", () => {
    expect(redact({ email: "a@b.c", passwordHash: "x", nested: { tokenHash: "y", ok: 1 }, list: [{ ciHash: "z" }] })).toEqual({
      email: "a@b.c",
      nested: { ok: 1 },
      list: [{}],
    });
  });
});
