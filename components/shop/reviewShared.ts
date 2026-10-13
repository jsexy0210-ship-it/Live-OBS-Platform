// 리뷰 화면 공통: 별점 문구, KST 날짜, 사진 다시 저장(긴 변 1600px JPEG 0.85, 위치 정보 등 메타데이터는 다시 그리면서 빠진다)
import { formatDate } from "../../lib/client/format";

export const RATING_TEXT = ["", "별로예요", "그저 그래요", "보통이에요", "좋아요", "아주 좋아요"];
export const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
export const md = (iso: string) => formatDate(iso);

export const PHOTO_MAX_SIDE = 1600;

// 고른 사진을 canvas에 다시 그려 JPEG로 저장한다(사진 방향은 반영, EXIF·위치 정보는 남지 않음). 실패하면 null.
export async function reencodePhoto(file: File): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85));
  } catch {
    return null;
  }
}

export async function call<T>(path: string, init?: { method: string; body?: unknown; raw?: Blob }): Promise<{ ok: true; data: T } | { ok: false; status: number; message?: string; error?: string }> {
  try {
    const res = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.raw ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data: data as T };
    const b = data as { message?: string; error?: string };
    return { ok: false, status: res.status, message: b.message, error: b.error };
  } catch {
    return { ok: false, status: 0 };
  }
}
