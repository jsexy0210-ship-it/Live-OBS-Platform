import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// TOTP 비밀키 등 저장용 AES-256-GCM 암호화. 키는 환경변수 SECRET_BOX_KEY(32바이트 base64)로만 받는다.
function key(): Buffer {
  const raw = process.env.SECRET_BOX_KEY;
  if (!raw) throw new Error("SECRET_BOX_KEY가 설정되지 않았어요.");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("SECRET_BOX_KEY는 32바이트(base64)여야 해요.");
  return buf;
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function open(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("암호문 형식이 올바르지 않아요.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
