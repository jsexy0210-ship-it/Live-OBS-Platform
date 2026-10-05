"use client";

import { useRef, useState } from "react";
import { apiUpload } from "./api";
import { INQUIRY_IMAGES_MAX } from "./platformInquiry";

// 문의 사진 첨부(SA-114·115). 고르면 바로 올리고(POST /api/seller/platform-inquiries/images), 글을 보낼 때 id만 함께 보낸다. JPG·PNG·WEBP 5MB, 5장까지.
export type Attached = { id: string; url: string };

export function InquiryAttach({ images, onChange, disabled }: { images: Attached[]; onChange: (next: Attached[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    let next = images;
    for (const file of Array.from(files)) {
      if (next.length >= INQUIRY_IMAGES_MAX) {
        setError(`사진은 ${INQUIRY_IMAGES_MAX}장까지 붙일 수 있습니다`);
        break;
      }
      const r = await apiUpload<{ image: Attached }>("/api/seller/platform-inquiries/images", file);
      if (!r.ok) {
        setError(r.message ?? "사진을 올리지 못했습니다. 사진 형식(JPG, PNG, WEBP)과 크기(5MB 이하)를 확인한 뒤 다시 올려 주십시오");
        break;
      }
      next = [...next, { id: r.data.image.id, url: r.data.image.url }];
    }
    setBusy(false);
    onChange(next);
    if (input.current) input.current.value = "";
  };

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {images.map((im) => (
          <span key={im.id} style={{ position: "relative" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={im.url} alt="첨부 사진" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 8 }} />
            <button type="button" className="btn btn-sm btn-out" aria-label="사진 빼기" disabled={disabled || busy} style={{ position: "absolute", top: -6, right: -6, minWidth: 0, padding: "0 6px" }} onClick={() => onChange(images.filter((x) => x.id !== im.id))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button type="button" className={`btn btn-sm btn-out${busy ? " is-loading" : ""}`} disabled={disabled || busy || images.length >= INQUIRY_IMAGES_MAX} onClick={() => input.current?.click()}>
          사진 첨부
        </button>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden aria-label="사진 파일" onChange={(e) => void pick(e.target.files)} />
        <span className="t-c1 c-alt">JPG · PNG · WEBP, 5MB 이하, {INQUIRY_IMAGES_MAX}장까지</span>
      </div>
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
