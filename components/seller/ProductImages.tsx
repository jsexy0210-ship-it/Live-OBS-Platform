"use client";

import "./ProductMedia.css";
import { useRef, useState } from "react";

// 상품 이미지 칸(SA-012): 첫 칸이 대표 이미지(썸네일), 이어서 추가 이미지. 끌어서(또는 ◀ ▶ 버튼으로) 순서를 바꾸고, 올리는 중·실패 상태를 칸마다 보여 준다.
// 저장·업로드는 부모가 한다(제어형): images를 그리고, 바뀌는 일은 onAdd·onRemove·onReorder·onRetry로 알린다.
export type SlotImage = {
  id: string;
  url: string;
  state: "uploading" | "done" | "error";
  // 올리는 중 진행률(0~100). 모르면 비운다
  progress?: number;
  error?: string;
};

export const IMAGE_ACCEPT = ["image/jpeg", "image/png"] as const;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 10;

// 고른 파일 중 올릴 수 있는 것만 남기고, 못 올리는 이유는 한 줄로 돌려 준다(종류·크기·남은 칸)
export function pickUploadable(files: File[], room: number): { ok: File[]; problem: string | null } {
  const ok: File[] = [];
  let problem: string | null = null;
  for (const f of files) {
    if (!(IMAGE_ACCEPT as readonly string[]).includes(f.type)) problem = "JPG · PNG만 올릴 수 있습니다";
    else if (f.size > IMAGE_MAX_BYTES) problem = "10MB 이하만 올릴 수 있습니다";
    else if (ok.length >= room) problem = `이미지는 ${IMAGE_MAX_COUNT}장까지 올릴 수 있습니다`;
    else ok.push(f);
  }
  return { ok, problem };
}

export default function ProductImages({
  images,
  max = IMAGE_MAX_COUNT,
  disabled,
  onAdd,
  onRemove,
  onReorder,
  onRetry,
}: {
  images: SlotImage[];
  max?: number;
  disabled?: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onRetry?: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const add = (files: File[]) => {
    const r = pickUploadable(files, max - images.length);
    setProblem(r.problem);
    if (r.ok.length) onAdd(r.ok);
  };
  const full = images.length >= max;
  // 칸 수: 올린 이미지 + 빈 칸 하나(꽉 차면 없음). 빈 칸이 없으면 새로 올릴 곳이 없다
  const empties = full ? 0 : 1;

  return (
    <div className="pm">
      <div
        className={`pm-grid${over ? " is-over" : ""}`}
        onDragOver={(e) => {
          if (disabled || dragFrom !== null || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (disabled || dragFrom !== null || !e.dataTransfer.files.length) return;
          e.preventDefault();
          setOver(false);
          add(Array.from(e.dataTransfer.files));
        }}
      >
        {images.map((img, i) => (
          <div
            key={img.id}
            className={`pm-tile${img.state === "error" ? " is-error" : ""}${dragFrom === i ? " is-drag" : ""}${dropAt === i && dragFrom !== i ? " is-drop" : ""}`}
            data-testid="product-image"
            draggable={!disabled && img.state === "done"}
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", img.id);
            }}
            onDragOver={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              setDropAt(i);
            }}
            onDrop={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              if (dragFrom !== i) onReorder(dragFrom, i);
              setDragFrom(null);
              setDropAt(null);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDropAt(null);
            }}
          >
            {img.state !== "error" && <img src={img.url} alt={i === 0 ? "대표 이미지" : `이미지 ${i + 1}`} draggable={false} />}
            {i === 0 && <span className="pm-badge">대표</span>}
            {img.state === "uploading" && (
              <div className="pm-prog" role="progressbar" aria-label={`이미지 ${i + 1} 올리는 중`} aria-valuenow={img.progress ?? undefined} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ width: `${img.progress ?? 30}%` }} />
              </div>
            )}
            {img.state === "error" && <span className="pm-fail">{img.error ?? "올리지 못했습니다"}</span>}
            <div className="pm-ov">
              {img.state === "error" && onRetry && (
                <button className="btn btn-sm btn-out" type="button" onClick={() => onRetry(img.id)} disabled={disabled}>
                  다시 시도
                </button>
              )}
              <div className="row" style={{ gap: 4 }}>
                <button className="btn btn-sm btn-out" type="button" aria-label={`이미지 ${i + 1} 앞으로`} disabled={disabled || i === 0 || img.state !== "done"} onClick={() => onReorder(i, i - 1)}>
                  ◀
                </button>
                <button className="btn btn-sm btn-out" type="button" aria-label={`이미지 ${i + 1} 뒤로`} disabled={disabled || i === images.length - 1 || img.state !== "done"} onClick={() => onReorder(i, i + 1)}>
                  ▶
                </button>
              </div>
              <button className="btn btn-sm btn-out" type="button" aria-label={`이미지 ${i + 1} 지우기`} disabled={disabled} onClick={() => onRemove(img.id)}>
                지우기
              </button>
            </div>
          </div>
        ))}
        {empties > 0 && (
          <button className="pm-tile pm-add" type="button" disabled={disabled} onClick={() => input.current?.click()} aria-label={images.length === 0 ? "대표 이미지 올리기" : "이미지 올리기"}>
            <b aria-hidden="true">+</b>
            <span>{images.length === 0 ? "대표 이미지" : `${images.length + 1}`}</span>
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept={IMAGE_ACCEPT.join(",")}
          multiple
          hidden
          aria-label="상품 이미지 파일"
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      <span className="help">첫 번째가 대표 이미지입니다 · 끌어서 순서 변경 · 1:1 비율 권장 · JPG · PNG · 10MB 이하 · 칸을 누르거나 파일을 끌어다 놓으면 올라갑니다</span>
      <span className="pm-count num">
        {images.length} / {max}
      </span>
      {problem && (
        <span className="err" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
