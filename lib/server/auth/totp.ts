import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 6238 TOTP (SHA-1, 30초, 6자리). 인증 앱(Google Authenticator 등) 기본값과 같다.
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretBase32: string, at: Date): string {
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  return hotp(base32Decode(secretBase32), counter);
}

// 맞는 코드의 카운터(30초 단위 순번)를 돌려준다. 앞뒤 1스텝(±30초)까지 허용하고, 아니면 null.
// 재사용을 막으려면 호출하는 쪽에서 마지막으로 받아들인 카운터보다 큰지 확인한다.
export function matchTotpCounter(secretBase32: string, code: string, at: Date, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretBase32);
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(key, counter + i);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return counter + i;
  }
  return null;
}

export function verifyTotp(secretBase32: string, code: string, at: Date, window = 1): boolean {
  return matchTotpCounter(secretBase32, code, at, window) !== null;
}

function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return bin.toString().padStart(DIGITS, "0");
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("base32 형식이 올바르지 않아요.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
