import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { signV4, kakaoStorage } from "../../lib/server/storage/kakao";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const SELLER = "seller1";
const UID = "123e4567-e89b-42d3-a456-426614174000";

describe("signV4", () => {
  // AWS S3 문서 「GET Object 예시」의 공개 시험 값(examplebucket, 2013-05-24)
  it("AWS 문서 예시 서명과 같다", () => {
    const auth = signV4({
      method: "GET", path: "/test.txt",
      headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9", "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "x-amz-date": "20130524T000000Z" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", amzDate: "20130524T000000Z",
    });
    expect(auth).toContain("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(auth).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
  });
});

describe("kakaoStorage", () => {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  let store: Map<string, { body: Uint8Array; headers: Record<string, string> }>;
  beforeEach(() => {
    process.env.IMAGE_S3_ENDPOINT = "https://objectstorage.example.test/";
    process.env.IMAGE_S3_REGION = "kr-central-2";
    process.env.IMAGE_S3_BUCKET = "bkt";
    process.env.IMAGE_S3_ACCESS_KEY_ID = "ak";
    process.env.IMAGE_S3_SECRET_ACCESS_KEY = "sk";
    calls.length = 0;
    store = new Map();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ method: init.method as string, url, headers });
      if (init.method === "PUT") { store.set(url, { body: init.body as Uint8Array, headers }); return new Response(null, { status: 200 }); }
      if (init.method === "DELETE") { store.delete(url); return new Response(null, { status: 204 }); }
      const o = store.get(url);
      if (!o) return new Response(null, { status: 404 });
      return new Response(o.body as BodyInit, { status: 200, headers: { "content-type": o.headers["content-type"], "x-amz-meta-sha256": o.headers["x-amz-meta-sha256"] } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const bytes = Buffer.from("png-bytes");
  const input = { sellerId: SELLER, bytes, contentType: "image/png" as const, sha256: sha(bytes) };

  it("저장·읽기·삭제와 판매자 격리", async () => {
    const key = await kakaoStorage.putImage({} as never, input);
    expect(key).toMatch(new RegExp(`^kakao:${SELLER}/[0-9a-f-]{36}$`));
    const put = calls[0];
    expect(put.url).toMatch(/^https:\/\/objectstorage\.example\.test\/bkt\/images\/seller1\/[0-9a-f-]{36}$/);
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ak\/\d{8}\/kr-central-2\/s3\/aws4_request, SignedHeaders=/);
    expect(put.headers["x-amz-content-sha256"]).toBe(input.sha256);
    const got = await kakaoStorage.getImage({} as never, key, SELLER);
    expect(got && Buffer.from(got.data).toString()).toBe("png-bytes");
    expect(got?.contentType).toBe("image/png");
    expect(await kakaoStorage.getImage({} as never, key, "other")).toBeNull();
    await kakaoStorage.deleteImage({} as never, key, "other");
    expect(store.size).toBe(1);
    await kakaoStorage.deleteImage({} as never, key, SELLER);
    expect(store.size).toBe(0);
    expect(await kakaoStorage.getImage({} as never, key, SELLER)).toBeNull();
  });

  it("모양이 틀린 키는 요청 없이 null", async () => {
    for (const k of ["db:x", "kakao:", `kakao:${SELLER}/../${UID}`, `kakao:${SELLER}/nope`]) expect(await kakaoStorage.getImage({} as never, k, SELLER)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("저장된 해시와 바이트가 다르면 거부", async () => {
    const key = await kakaoStorage.putImage({} as never, { ...input, sha256: "0".repeat(64) });
    await expect(kakaoStorage.getImage({} as never, key, SELLER)).rejects.toThrow("hash mismatch");
  });

  it("설정이 빠지면 값 없이 이름만 담은 오류", async () => {
    delete process.env.IMAGE_S3_SECRET_ACCESS_KEY;
    await expect(kakaoStorage.putImage({} as never, input)).rejects.toThrow("IMAGE_S3_SECRET_ACCESS_KEY");
    expect(calls).toHaveLength(0);
  });

  it("서버 오류는 던진다", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 403 }));
    await expect(kakaoStorage.putImage({} as never, input)).rejects.toThrow("403");
  });
});
