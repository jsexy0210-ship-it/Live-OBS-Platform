import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// PG가 준 빌링키는 원문으로 저장하지 않는다. 서버 비밀키(BILLING_KEY_SECRET)로 AES-256-GCM 암호화해서만 저장한다.
function key(): Buffer {
  const secret = process.env.BILLING_KEY_SECRET;
  if (!secret || secret.length < 32) throw new Error("BILLING_KEY_SECRET이 없거나 너무 짧아요(32자 이상).");
  return createHash("sha256").update(secret, "utf8").digest();
}

export function sealBillingKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function openBillingKey(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("빌링키 형식이 올바르지 않아요.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
