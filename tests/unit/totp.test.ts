import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp } from "../../lib/server/auth/totp";

// RFC 6238 부록 B 시험값 (SHA-1, 비밀키 "12345678901234567890"), 6자리로 자른 값
const SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("RFC 6238 시험값과 같다", () => {
    expect(SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(totpCode(SECRET, new Date(59_000))).toBe("287082");
    expect(totpCode(SECRET, new Date(1111111109_000))).toBe("081804");
    expect(totpCode(SECRET, new Date(1234567890_000))).toBe("005924");
  });

  it("앞뒤 30초까지 허용하고 그 밖은 거부", () => {
    const at = new Date(1111111109_000);
    const code = totpCode(SECRET, at);
    expect(verifyTotp(SECRET, code, new Date(at.getTime() + 30_000))).toBe(true);
    expect(verifyTotp(SECRET, code, new Date(at.getTime() + 90_000))).toBe(false);
    expect(verifyTotp(SECRET, "12345", at)).toBe(false);
  });

  it("base32 왕복", () => {
    const s = generateTotpSecret();
    expect(base32Encode(base32Decode(s))).toBe(s);
  });
});
