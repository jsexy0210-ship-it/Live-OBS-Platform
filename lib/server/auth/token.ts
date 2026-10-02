import { createHash, randomBytes } from "node:crypto";

// 세션·오버레이 토큰: 256비트 무작위 값. DB에는 SHA-256 해시만 저장한다.
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
