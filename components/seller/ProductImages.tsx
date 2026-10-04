"use client";

import "./ProductMedia.css";
import { useEffect, useRef, useState } from "react";

// 상품 이미지 칸(SA-012): 첫 칸이 대표 이미지(썸네일), 이어서 추가 이미지. 끌어서(또는 ‹ › 버튼으로) 순서를 바꾸고, 올리는 중·실패 상태를 칸마다 보여 준다.
// 저장·업로드는 부모가 한다(제어형): images를 그리고, 바뀌는 일은 onAdd·onRemove·onRestore·onReorder·onRetry로 알린다.
export type SlotImage = {
  id: string;
  url: string;
  state: "uploading" | "done" | "error";
  // 올리는 중 진행률(0~100). 모르면 비운다
  progress?: number;
  error?: string;
};

// 서버가 받는 형식(기반-상품 계약: PNG·JPG·WEBP, 장당 5MB, 10장, 가로·세로 100~4000px). 바뀌면 여기와 IMAGE_LABEL만 바꾼다
export const IMAGE_ACCEPT = ["image/png", "image/jpeg", "image/webp"] as const;
export const IMAGE_LABEL = "PNG · JPG · WEBP";
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 10;
// 지운 자리에 「되돌리기」를 보이는 시간
export const UNDO_MS = 5000;

// 고른 파일 중 올릴 수 있는 것만 남기고, 못 올리는 이유는 한 줄로 돌려 준다(종류·크기·남은 칸)
export function pickUploadable(files: File[], room: number): { ok: File[]; problem: string | null } {
  const ok: File[] = [];
  let problem: string | null = null;
  for (const f of files) {
    if (!(IMAGE_ACCEPT as readonly string[]).includes(f.type)) problem = `${IMAGE_LABEL}만 올릴 수 있습니다`;
    else if (f.size > IMAGE_MAX_BYTES) problem = "5MB 이하만 올릴 수 있습니다";
    else if (ok.length >= room) problem = `이미지는 ${IMAGE_MAX_COUNT}장까지 올릴 수 있습니다`;
    else ok.push(f);
  }
  return { ok, problem };
}

type Ghost = { img: SlotImage; index: number; timer: ReturnType<typeof setTimeout> };

export default function ProductImages({
  images,
  max = IMAGE_MAX_COUNT,
  disabled,
  onAdd,
  onRemove,
  onRestore,
  onReorder,
  onRetry,
}: {
  images: SlotImage[];
  max?: number;
  disabled?: boolean;
  onAdd: (files: File[]) => void;
  // 지웠다. 부모는 바로 목록에서 빼고(저장할 때 서버에서 지움), 5초 안에 되돌리면 onRestore로 다시 받는다
  onRemove: (id: string) => void;
  onRestore: (image: SlotImage, index: number) => void;
  onReorder: (from: number, to: number) => void;
  onRetry?: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  // 지운 직후 그 자리에 「지웠습니다 · 되돌리기」를 5초 보인다
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const ghostsRef = useRef(ghosts);
  ghostsRef.current = ghosts;
  useEffect(
    () => () => {
      ghostsRef.current.forEach((g) => clearTimeout(g.timer));
    },
    [],
  );
  const remove = (img: SlotImage, index: number) => {
    // 타이머는 상태 갱신 함수 밖에서 만든다(갱신 함수는 두 번 불릴 수 있다)
    const timer = setTimeout(() => setGhosts((cur) => cur.filter((g) => g.img.id !== img.id)), UNDO_MS);
    setGhosts((cur) => [...cur, { img, index, timer }]);
    onRemove(img.id);
  };
  const restore = (g: Ghost) => {
    clearTimeout(g.timer);
    setGhosts((cur) => cur.filter((x) => x !== g));
    onRestore(g.img, g.index);
  };

  const add = (files: File[]) => {
    const r = pickUploadable(files, max - images.length - ghosts.length);
    setProblem(r.problem);
    if (r.ok.length) onAdd(r.ok);
  };
  // 칸은 항상 max개: 올린 이미지(와 지운 자리) 다음에 빈 칸. 첫 빈 칸이 「+ 추가 이미지」(없으면 「대표 이미지」), 나머지는 번호만 보인다
  const empties = Math.max(0, max - images.length - ghosts.length);

  // 그리는 순서: 이미지 목록에 지운 자리를 원래 위치로 끼워 넣는다
  type Cell = { kind: "img"; img: SlotImage; i: number } | { kind: "ghost"; g: Ghost };
  const cells: Cell[] = images.map((img, i) => ({ kind: "img", img, i }));
  [...ghosts]
    .sort((a, b) => a.index - b.index)
    .forEach((g) => cells.splice(Math.min(g.index, cells.length), 0, { kind: "ghost", g }));

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
        {cells.map((cell) => {
          if (cell.kind === "ghost") {
            return (
              <div key={`ghost-${cell.g.img.id}`} className="pm-tile pm-undo" data-testid="product-image-removed">
                <span>지웠습니다</span>
                <button className="btn btn-sm btn-out" type="button" disabled={disabled} onClick={() => restore(cell.g)}>
                  되돌리기
                </button>
              </div>
            );
          }
          const { img, i } = cell;
          return (
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
                    ‹
                  </button>
                  <button
                    className="btn btn-sm btn-out"
                    type="button"
                    aria-label={`이미지 ${i + 1} 뒤로`}
                    disabled={disabled || i === images.length - 1 || img.state !== "done"}
                    onClick={() => onReorder(i, i + 1)}
                  >
                    ›
                  </button>
                </div>
                <button className="btn btn-sm btn-out" type="button" aria-label={`이미지 ${i + 1} 지우기`} disabled={disabled} onClick={() => remove(img, i)}>
                  지우기
                </button>
              </div>
            </div>
          );
        })}
        {Array.from({ length: empties }, (_, k) => {
          const n = images.length + ghosts.length + k + 1;
          return (
            <button
              key={`empty-${n}`}
              className={`pm-tile pm-add${k === 0 ? " is-first" : ""}`}
              type="button"
              disabled={disabled}
              onClick={() => input.current?.click()}
              aria-label={n === 1 ? "대표 이미지 올리기" : `이미지 ${n} 올리기`}
            >
              <b aria-hidden="true">+</b>
              <span>{k === 0 ? (n === 1 ? "대표 이미지" : "추가 이미지") : n}</span>
            </button>
          );
        })}
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
      <span className="help">
        대표 이미지 1장 + 추가 이미지 {max - 1}장 = 최대 {max}장 · 첫 번째가 대표 이미지(목록 · 공유 카드 · 오버레이) · 끌어서 순서 변경, ‹ › 로도 옮깁니다 · 1:1 비율 권장 · {IMAGE_LABEL} · 장당 5MB
      </span>
      {problem && (
        <span className="err" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
