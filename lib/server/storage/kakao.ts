import { createHash, createHmac } from "node:crypto";
import type { ImageStorage } from "./index";

// 카카오 Object Storage 드라이버(IMAGE_STORAGE=kakao): S3 호환 API, path-style, SigV4. 비공개 버킷이라 주소를 밖에 주지 않고
// 앱이 getImage로 읽어 우리 경로(/api/.../images/[id])로 응답한다. storageKey = "kakao:<sellerId>/<uuid>", 오브젝트 키 = "images/<sellerId>/<uuid>".
// 설정(.env): IMAGE_S3_ENDPOINT, IMAGE_S3_REGION, IMAGE_S3_BUCKET, IMAGE_S3_ACCESS_KEY_ID, IMAGE_S3_SECRET_ACCESS_KEY.
// 주의: 오브젝트 저장은 DB 트랜잭션 밖이라, 업로드 기록이 롤백되면 오브젝트가 남을 수 있다(정리 작업은 이전 스크립트 몫).
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = new RegExp(`^kakao:([0-9a-zA-Z_-]+)/(${UUID})$`, "i");
const SHA256 = /^[0-9a-f]{64}$/;

type S3Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };

function config(): S3Config {
  const names = ["IMAGE_S3_ENDPOINT", "IMAGE_S3_REGION", "IMAGE_S3_BUCKET", "IMAGE_S3_ACCESS_KEY_ID", "IMAGE_S3_SECRET_ACCESS_KEY"] as const;
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`kakao storage env missing: ${missing.join(", ")}`);
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = names.map((n) => process.env[n] as string);
  return { endpoint: endpoint.replace(/\/+$/, ""), region, bucket, accessKeyId, secretAccessKey };
}

const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const encodePath = (p: string) => p.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

// AWS SigV4(헤더 방식). headers에는 서명할 헤더(host 포함)를 모두 넣는다. 반환값은 Authorization 헤더 값.
export function signV4(opts: {
  method: string; path: string; query?: string; headers: Record<string, string>; payloadHash: string;
  region: string; accessKeyId: string; secretAccessKey: string; amzDate: string; service?: string;
}): string {
  const service = opts.service ?? "s3";
  const day = opts.amzDate.slice(0, 8);
  const names = Object.keys(opts.headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const canonical = [opts.method, opts.path, opts.query ?? "", ...names.map((n) => `${n}:${lower[n]}`), "", names.join(";"), opts.payloadHash].join("\n");
  const scope = `${day}/${opts.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", opts.amzDate, scope, sha256Hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), opts.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

async function s3(method: "PUT" | "GET" | "DELETE", objectKey: string, body?: Buffer, extra: Record<string, string> = {}) {
  const c = config();
  const url = new URL(c.endpoint);
  const path = `/${encodePath(c.bucket)}/${encodePath(objectKey)}`;
  const payloadHash = body ? sha256Hex(body) : sha256Hex("");
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extra };
  const authorization = signV4({ method, path, headers, payloadHash, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, amzDate });
  const { host: _host, ...sendHeaders } = headers;
  void _host;
  return fetch(`${url.origin}${path}`, { method, headers: { ...sendHeaders, authorization }, body: body ? new Uint8Array(body) : undefined });
}

const parse = (storageKey: string) => {
  const m = KEY.exec(storageKey);
  return m ? { sellerId: m[1], id: m[2].toLowerCase() } : null;
};

export const kakaoStorage: ImageStorage = {
  name: "kakao",
  async putImage(_tx, { sellerId, bytes, contentType, sha256 }) {
    if (!/^[0-9a-zA-Z_-]+$/.test(sellerId)) throw new Error("invalid sellerId for storage");
    const id = crypto.randomUUID();
    const res = await s3("PUT", `images/${sellerId}/${id}`, bytes, { "content-type": contentType, "x-amz-meta-sha256": sha256 });
    if (!res.ok) throw new Error(`kakao storage put failed: ${res.status}`);
    return `kakao:${sellerId}/${id}`;
  },
  async getImage(_db, storageKey, sellerId) {
    const k = parse(storageKey);
    if (!k || k.sellerId !== sellerId) return null;
    const res = await s3("GET", `images/${k.sellerId}/${k.id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`kakao storage get failed: ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    const sha256 = sha256Hex(data);
    const expected = res.headers.get("x-amz-meta-sha256");
    // 저장 때 기록한 해시와 다르면 깨진 바이트로 보고 주지 않는다(DB 드라이버의 해시 CHECK에 해당).
    if (expected && SHA256.test(expected) && expected !== sha256) throw new Error("kakao storage hash mismatch");
    return { data, contentType: res.headers.get("content-type") || "application/octet-stream", sha256 };
  },
  async deleteImage(_tx, storageKey, sellerId) {
    const k = parse(storageKey);
    if (!k || k.sellerId !== sellerId) return;
    const res = await s3("DELETE", `images/${k.sellerId}/${k.id}`);
    if (!res.ok && res.status !== 404) throw new Error(`kakao storage delete failed: ${res.status}`);
  },
};
