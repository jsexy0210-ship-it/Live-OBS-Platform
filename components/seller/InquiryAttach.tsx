"use client";

import { useRef, useState } from "react";
import { apiUpload } from "./api";
import { INQUIRY_IMAGES_MAX } from "./platformInquiry";

// 문의 첨부(SA-114·115). 고르면 바로 올리고, 글을 보낼 때 id만 함께 보낸다. 사진은 POST …/images(JPG·PNG·WEBP), files를 함께 받는 화면(문의하기)은
// 사진 외 .txt·.log·.zip도 POST …/files?name=으로 올린다. 하나에 5MB, 사진·파일 합쳐 5개·20MB까지(서버 기준).
export type Attached = { id: string; url: string };
export type AttachedFile = { id: string; name: string; byteSize: number; url: string };
const TOTAL_MAX = 20 * 1024 * 1024;
const FILE_EXT = /\.(txt|log|zip)$/i;
const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export function InquiryAttach({ images, onChange, files, onFilesChange, disabled }: { images: Attached[]; onChange: (next: Attached[]) => void; files?: AttachedFile[]; onFilesChange?: (next: AttachedFile[]) => void; disabled?: boolean }) {
  const withFiles = !!onFilesChange;
  const fileList = files ?? [];
  const count = images.length + fileList.length;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 올린 사진의 바이트는 모르므로 합계는 이번 화면에서 올린 크기를 따로 센다
  const sizes = useRef<Record<string, number>>({});
  const total = () => [...images, ...fileList].reduce((n, x) => n + (sizes.current[x.id] ?? 0), 0);

  const pick = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    setError(null);
    setBusy(true);
    let nextImages = images;
    let nextFiles = fileList;
    let sum = total();
    for (const file of Array.from(picked)) {
      if (nextImages.length + nextFiles.length >= INQUIRY_IMAGES_MAX) {
        setError(withFiles ? `첨부는 ${INQUIRY_IMAGES_MAX}개까지 붙일 수 있습니다` : `사진은 ${INQUIRY_IMAGES_MAX}장까지 붙일 수 있습니다`);
        break;
      }
      if (sum + file.size > TOTAL_MAX) {
        setError(`${file.name}을 올리지 못했습니다. 첨부는 합쳐서 20MB까지입니다 · 압축하거나 최근 부분만 올려 주십시오`);
        break;
      }
      const isImage = file.type.startsWith("image/");
      if (!isImage && !(withFiles && FILE_EXT.test(file.name))) {
        setError(`${file.name}을 올리지 못했습니다. 사진(JPG · PNG · WEBP)${withFiles ? "과 .txt · .log · .zip" : ""}만 올릴 수 있습니다`);
        break;
      }
      if (isImage) {
        const r = await apiUpload<{ image: Attached }>("/api/seller/platform-inquiries/images", file);
        if (!r.ok) {
          setError(r.message ?? "사진을 올리지 못했습니다. 사진 형식(JPG, PNG, WEBP)과 크기(5MB 이하)를 확인한 뒤 다시 올려 주십시오");
          break;
        }
        sizes.current[r.data.image.id] = file.size;
        nextImages = [...nextImages, { id: r.data.image.id, url: r.data.image.url }];
      } else {
        const r = await apiUpload<{ file: AttachedFile }>(`/api/seller/platform-inquiries/files?name=${encodeURIComponent(file.name)}`, file);
        if (!r.ok) {
          setError(`${file.name}을 올리지 못했습니다. ${r.message ?? "하나에 5MB까지 올릴 수 있습니다 · 압축하거나 최근 부분만 올려 주십시오"}`);
          break;
        }
        sizes.current[r.data.file.id] = file.size;
        nextFiles = [...nextFiles, r.data.file];
      }
      sum += file.size;
    }
    setBusy(false);
    onChange(nextImages);
    onFilesChange?.(nextFiles);
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
      {fileList.map((f) => (
        <div key={f.id} className="row" style={{ gap: 8, alignItems: "center" }} data-testid="inquiry-file">
          <span>
            {f.name} · {sizeText(f.byteSize)}
          </span>
          <button type="button" className="btn btn-sm btn-text" aria-label={`${f.name} 빼기`} disabled={disabled || busy} onClick={() => onFilesChange?.(fileList.filter((x) => x.id !== f.id))}>
            빼기
          </button>
        </div>
      ))}
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button type="button" className={`btn btn-sm btn-out${busy ? " is-loading" : ""}`} disabled={disabled || busy || count >= INQUIRY_IMAGES_MAX} onClick={() => input.current?.click()}>
          {withFiles ? "파일 선택" : "사진 첨부"}
        </button>
        <input ref={input} type="file" accept={withFiles ? "image/jpeg,image/png,image/webp,.txt,.log,.zip" : "image/jpeg,image/png,image/webp"} multiple hidden aria-label={withFiles ? "첨부 파일" : "사진 파일"} onChange={(e) => void pick(e.target.files)} />
        <span className="t-c1 c-alt">{withFiles ? `최대 ${INQUIRY_IMAGES_MAX}개 · 20MB · 스크린샷 · OBS 로그 권장` : `JPG · PNG · WEBP, 5MB 이하, ${INQUIRY_IMAGES_MAX}장까지`}</span>
      </div>
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
