import { createHmac } from "node:crypto";

// CI 원문은 저장하지 않는다. 서버 비밀키(IDENTITY_HASH_KEY)로 만든 HMAC-SHA256 값만 저장·비교한다.
export function hashCi(ci: string): string {
  const key = process.env.IDENTITY_HASH_KEY;
  if (!key || key.length < 32) throw new Error("IDENTITY_HASH_KEY가 없거나 너무 짧아요(32자 이상).");
  return createHmac("sha256", key).update(ci, "utf8").digest("hex");
}
