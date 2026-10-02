import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// PG가 준 빌링키는 원문으로 저장하지 않는다. 서버 비밀키(BILLING_KEY_SECRET)로 AES-256-GCM 암호화해서만 저장하고,
// 판매자 id를 추가 인증 데이터(AAD)로 묶어 다른 판매자 행으로 옮겨 붙이면 풀리지 않게 한다.
// 키 교체 절차는 docs/ARCHITECTURE.md 4.8.1 참고.

export class BillingSecretMissing extends Error {
  constructor() {
    super("BILLING_KEY_SECRET이 없거나 너무 짧아요(32자 이상).");
  }
}

function key(): Buffer {
  const secret = process.env.BILLING_KEY_SECRET;
  if (!secret || secret.length < 32) throw new BillingSecretMissing();
  return createHash("sha256").update(secret, "utf8").digest();
}

// PG를 부르기 전에 확인한다(빌링키를 받아 놓고 저장하지 못하는 일을 막는다).
export function assertBillingSecret(): void {
  key();
}

export function sealBillingKey(plain: string, sellerId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(sellerId, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function openBillingKey(sealed: string, sellerId: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("빌링키 형식이 올바르지 않아요.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(sellerId, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
