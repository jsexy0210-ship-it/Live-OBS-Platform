import { hash, verify } from "@node-rs/argon2";

// argon2id 기본값(@node-rs/argon2: m=19456 KiB, t=2, p=1, OWASP 권고 수준).
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

// 없는 계정으로 로그인할 때도 해시 검증 시간을 써서 계정 존재 여부가 응답 시간으로 드러나지 않게 한다.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= hash("dummy-password-for-timing");
  await verifyPassword(await dummyHash, plain);
}
