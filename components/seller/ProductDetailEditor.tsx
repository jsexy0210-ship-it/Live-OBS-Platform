"use client";

import "./ProductMedia.css";
import { useRef, useState } from "react";
import { IMAGE_ACCEPT, IMAGE_LABEL, IMAGE_MAX_BYTES, pickUploadable, type SlotImage } from "./ProductImages";

// 상품 상세 페이지 편집 칸(SA-012): 글 블록과 이미지 블록을 쌓고, 손잡이로 끌거나 ↑ ↓로 순서를 바꾸고, 「미리보기」로 구매자 화면 순서대로 본다.
// 저장·업로드는 부모가 한다(제어형): blocks를 그리고, 바뀌는 일은 onChange로, 이미지 파일은 onPickImage로 알린다.
export type DetailBlock = { id: string; type: "text"; text: string } | { id: string; type: "image"; image: SlotImage | null };

export const DETAIL_MAX_BLOCKS = 30;
export const DETAIL_TEXT_MAX = 2000;

let seq = 0;
export const newBlockId = () => `b${Date.now().toString(36)}${++seq}`;

export default function ProductDetailEditor({
  blocks,
  disabled,
  max = DETAIL_MAX_BLOCKS,
  onChange,
  onPickImage,
  onRetryImage,
}: {
  blocks: DetailBlock[];
  disabled?: boolean;
  max?: number;
  onChange: (blocks: DetailBlock[]) => void;
  // 이미지 블록에 파일을 골랐다(새로 올리기·바꾸기 모두)
  onPickImage: (blockId: string, file: File) => void;
  onRetryImage?: (blockId: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // 끌어서 순서 바꾸기: 손잡이를 누른 블록만 끌 수 있다(글 칸 안에서 글자를 끌어 고르는 동작과 겹치지 않게)
  const [armed, setArmed] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const files = useRef<Record<string, HTMLInputElement | null>>({});
  const full = blocks.length >= max;

  const set = (id: string, patch: Partial<DetailBlock>) => onChange(blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as DetailBlock) : b)));
  const moveTo = (from: number, to: number) => {
    if (from === to || to < 0 || to >= blocks.length) return;
    const next = [...blocks];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m!);
    onChange(next);
  };
  const pick = (id: string, list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    const r = pickUploadable([f], 1);
    setProblem(r.problem);
    if (r.ok[0]) onPickImage(id, r.ok[0]);
  };

  return (
    <div className="pm-detail">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm btn-out" type="button" disabled={disabled || full || preview} onClick={() => onChange([...blocks, { id: newBlockId(), type: "text", text: "" }])}>
            + 글 블록
          </button>
          <button className="btn btn-sm btn-out" type="button" disabled={disabled || full || preview} onClick={() => onChange([...blocks, { id: newBlockId(), type: "image", image: null }])}>
            + 이미지 블록
          </button>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="t-c1 c-alt">
            블록 {blocks.length}개 · 이미지 블록은 가로 860px 권장 · 장당 {IMAGE_MAX_BYTES / 1024 / 1024}MB
          </span>
          <button className="btn btn-sm btn-out" type="button" aria-pressed={preview} onClick={() => setPreview((p) => !p)} disabled={blocks.length === 0}>
            {preview ? "편집으로 돌아가기" : "미리보기"}
          </button>
        </div>
      </div>

      {blocks.length === 0 && <span className="t-l2 c-alt">상세 페이지가 비어 있습니다. 글이나 이미지 블록을 추가하면 상품 상세 「상세 정보」 탭에 순서대로 표시됩니다</span>}

      {preview ? (
        <div className="pm-pv" data-testid="detail-preview">
          {blocks.map((b) => (b.type === "text" ? <p key={b.id}>{b.text || " "}</p> : b.image && b.image.state !== "error" ? <img key={b.id} src={b.image.url} alt="" /> : null))}
        </div>
      ) : (
        <ol className="pm-blocks">
          {blocks.map((b, i) => (
            <li
              key={b.id}
              className={`pm-block${dragFrom === i ? " is-drag" : ""}${dropAt === i && dragFrom !== i ? " is-drop" : ""}`}
              data-testid="detail-block"
              draggable={armed === b.id && !disabled}
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", b.id);
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDropAt(i);
              }}
              onDrop={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                moveTo(dragFrom, i);
                setDragFrom(null);
                setDropAt(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDropAt(null);
                setArmed(null);
              }}
            >
              <div className="pm-block-h">
                <div className="row" style={{ gap: 6 }}>
                  <span className="pm-grip" role="img" aria-label={`블록 ${i + 1} 끌어서 순서 변경`} title="끌어서 순서 변경" onPointerDown={() => setArmed(b.id)} onPointerUp={() => setArmed(null)}>
                    ⋮⋮
                  </span>
                  <span className="t-c1 c-alt">{b.type === "text" ? "글" : "이미지"}</span>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn btn-sm btn-out" type="button" aria-label={`블록 ${i + 1} 위로`} disabled={disabled || i === 0} onClick={() => moveTo(i, i - 1)}>
                    ↑
                  </button>
                  <button className="btn btn-sm btn-out" type="button" aria-label={`블록 ${i + 1} 아래로`} disabled={disabled || i === blocks.length - 1} onClick={() => moveTo(i, i + 1)}>
                    ↓
                  </button>
                  <button className="btn btn-sm btn-out" type="button" aria-label={`블록 ${i + 1} 삭제`} disabled={disabled} onClick={() => onChange(blocks.filter((x) => x.id !== b.id))}>
                    삭제
                  </button>
                </div>
              </div>
              {b.type === "text" ? (
                <textarea
                  className="inp"
                  aria-label={`블록 ${i + 1} 글`}
                  placeholder="구성 · 사용법 · 주의 사항을 입력해 주십시오"
                  maxLength={DETAIL_TEXT_MAX}
                  value={b.text}
                  disabled={disabled}
                  onChange={(e) => set(b.id, { text: e.target.value })}
                />
              ) : (
                <div className="col" style={{ gap: 6, alignItems: "flex-start" }}>
                  {b.image ? (
                    <div className={`pm-tile pm-wide${b.image.state === "error" ? " is-error" : ""}`}>
                      {b.image.state !== "error" && <img src={b.image.url} alt={`블록 ${i + 1} 이미지`} />}
                      {b.image.state === "uploading" && (
                        <div className="pm-prog" role="progressbar" aria-label={`블록 ${i + 1} 이미지 올리는 중`}>
                          <i style={{ width: `${b.image.progress ?? 30}%` }} />
                        </div>
                      )}
                      {b.image.state === "error" && <span className="pm-fail">{b.image.error ?? "올리지 못했습니다"}</span>}
                    </div>
                  ) : (
                    <span className="t-c1 c-alt">상세 이미지 · 가로 860px · 세로는 자유 · {IMAGE_MAX_BYTES / 1024 / 1024}MB</span>
                  )}
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-sm btn-out" type="button" disabled={disabled} onClick={() => files.current[b.id]?.click()}>
                      {b.image ? "바꾸기" : "이미지 올리기"}
                    </button>
                    {b.image?.state === "error" && onRetryImage && (
                      <button className="btn btn-sm btn-out" type="button" disabled={disabled} onClick={() => onRetryImage(b.id)}>
                        다시 시도
                      </button>
                    )}
                  </div>
                  <input
                    ref={(el) => {
                      files.current[b.id] = el;
                    }}
                    type="file"
                    accept={IMAGE_ACCEPT.join(",")}
                    hidden
                    aria-label={`블록 ${i + 1} 이미지 파일`}
                    onChange={(e) => {
                      pick(b.id, e.target.files);
                      e.target.value = "";
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <span className="help">
        글·이미지 블록은 최대 {max}개 · 글은 블록마다 {DETAIL_TEXT_MAX.toLocaleString("ko-KR")}자까지 · 이미지는 {IMAGE_LABEL} · 구매자 상품 상세 「상세 정보」 탭에 위에서부터 순서대로 표시됩니다
      </span>
      {problem && (
        <span className="err" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
