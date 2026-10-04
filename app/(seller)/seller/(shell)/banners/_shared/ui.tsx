"use client";

import { useRef, useState } from "react";
import "./shop-content.css";

// 홈 배너 관리·이벤트 팝업 관리가 함께 쓰는 화면 조각. 파트너스 관리자 문구는 명사형·합니다체(2026-10-04 대표님 지시).

export type ContentStatus = "live" | "scheduled" | "ended" | "hidden";
export type AdminImage = { id: string; width: number; height: number; url: string };

const STATUS: Record<ContentStatus, { label: string; cls: string }> = {
  live: { label: "게시 중", cls: "b-done" },
  scheduled: { label: "게시 예정", cls: "b-info" },
  ended: { label: "게시 종료", cls: "b-gray" },
  hidden: { label: "숨김", cls: "b-cancel" },
};

export function StatusBadge({ status }: { status: ContentStatus }) {
  return <span className={`bdg ${STATUS[status].cls}`}>{STATUS[status].label}</span>;
}

// ───────── 시각(KST) ─────────
// 입력 칸(datetime-local)은 KST 벽시계 값으로 다루고, 서버에는 +09:00을 붙여 보낸다.
export function toKstInput(iso: string | null): string {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16);
}
export const fromKstInput = (v: string): string | null => (v ? `${v}:00+09:00` : null);

export function kstText(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function periodText(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt && !endsAt) return "기간 제한 없음";
  if (!endsAt) return `${kstText(startsAt)}부터`;
  if (!startsAt) return `${kstText(endsAt)}까지`;
  return `${kstText(startsAt)} ~ ${kstText(endsAt)}`;
}

export function PeriodFields({ startsAt, endsAt, onChange, disabled }: { startsAt: string; endsAt: string; onChange: (v: { startsAt: string; endsAt: string }) => void; disabled?: boolean }) {
  const bad = !!startsAt && !!endsAt && startsAt >= endsAt;
  return (
    <div className="fld">
      <span className="lbl">게시 기간 (KST)</span>
      <div className="sc-period">
        <input className="inp" type="datetime-local" aria-label="시작 시각" value={startsAt} disabled={disabled} onChange={(e) => onChange({ startsAt: e.target.value, endsAt })} />
        <span className="c-alt">~</span>
        <input className="inp" type="datetime-local" aria-label="종료 시각" value={endsAt} disabled={disabled} onChange={(e) => onChange({ startsAt, endsAt: e.target.value })} />
      </div>
      {bad ? <span className="err">종료 시각은 시작 시각보다 늦어야 합니다</span> : <span className="help">비워 두면 그쪽 제한 없음 · 서버 시각 기준으로 게시·종료</span>}
    </div>
  );
}

// ───────── 이미지 올리기 ─────────
const IMAGE_ERRORS: Record<string, string> = {
  file_too_large: "이미지는 3MB까지 올릴 수 있습니다",
  unsupported_image: "PNG·JPEG 이미지만 올릴 수 있습니다",
  wrong_image_size: "이미지 가로·세로는 100~2000px이어야 합니다",
  empty_file: "빈 파일은 올릴 수 없습니다",
};

export function ImagePicker({
  label,
  hint,
  value,
  onChange,
  optional,
  disabled,
}: {
  label: string;
  hint: string;
  value: AdminImage | null;
  onChange: (v: AdminImage | null) => void;
  optional?: boolean;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      // 파일 바이트를 그대로 보낸다. 형식은 서버가 바이트로 확인한다.
      const res = await fetch("/api/seller/shop-content/images", { method: "POST", body: file, cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onChange(data.image as AdminImage);
      else setError(data.message ?? IMAGE_ERRORS[data.error] ?? (res.status === 403 ? "변경 권한이 없습니다" : "이미지를 올리지 못했습니다"));
    } catch {
      setError("연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="fld">
      <span className={optional ? "lbl" : "lbl req"}>{label}</span>
      <div className="sc-pick">
        {value ? (
          <img src={value.url} alt="" className="sc-pick-img" />
        ) : (
          <span className="sc-pick-empty t-c1 c-alt">{busy ? "올리는 중" : "이미지 없음"}</span>
        )}
        <div className="col" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button className="btn btn-sm btn-out" type="button" disabled={disabled || busy} onClick={() => input.current?.click()}>
              {busy ? "올리는 중" : value ? "이미지 변경" : "이미지 선택"}
            </button>
            {value && optional && (
              <button className="btn btn-sm btn-ghost" type="button" disabled={disabled || busy} onClick={() => onChange(null)}>
                삭제
              </button>
            )}
          </div>
          {value && (
            <span className="t-c1 c-alt num">
              {value.width} × {value.height}px
            </span>
          )}
          <span className="help">{hint}</span>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          aria-label={label}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// ───────── 링크 ─────────
// 서버(lib/server/shop-content/link.ts)와 같은 기준의 빠른 확인. 최종 판단은 서버가 한다.
export function linkLooksOk(v: string): boolean {
  const t = v.trim();
  if (!t) return true;
  if (/\s/.test(t)) return false;
  if (t.startsWith("/")) return !t.startsWith("//") && !t.startsWith("/\\");
  return /^https?:\/\/[^/]/i.test(t);
}

export function LinkField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const bad = !linkLooksOk(value);
  return (
    <div className="fld">
      <label htmlFor="sc-link">링크</label>
      <input
        id="sc-link"
        className={`inp${bad ? " is-error" : ""}`}
        placeholder="/products/상품 주소 또는 https://"
        value={value}
        maxLength={500}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {bad ? (
        <span className="err">쇼핑몰 안 경로(/로 시작) 또는 http(s) 주소만 입력할 수 있습니다</span>
      ) : (
        <span className="help">쇼핑몰 안 경로는 쇼핑몰 주소 뒤에 붙음 · 바깥 주소는 새 창으로 열림 · 비워 두면 링크 없음</span>
      )}
    </div>
  );
}

// ───────── 끌어서 순서 바꾸기 ─────────
// 마우스는 끌어서, 키보드·터치는 위·아래 버튼으로 옮긴다. 놓으면 onCommit(새 순서)을 부른다.
export function useSortable<T extends { id: string }>(items: T[], onCommit: (next: T[]) => void) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = items.slice();
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    onCommit(next);
  };
  const rowProps = (id: string, editable: boolean) =>
    editable
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            setDragId(id);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", id);
          },
          onDragOver: (e: React.DragEvent) => {
            if (!dragId) return;
            e.preventDefault();
            setOverId(id);
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            if (dragId) move(items.findIndex((i) => i.id === dragId), items.findIndex((i) => i.id === id));
            setDragId(null);
            setOverId(null);
          },
          onDragEnd: () => {
            setDragId(null);
            setOverId(null);
          },
          "data-dragging": dragId === id || undefined,
          "data-over": (overId === id && dragId !== id) || undefined,
        }
      : {};
  return { rowProps, move };
}

export function GripIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

// ───────── 화면 상태(명사형·합니다체) ─────────
export function StateBox({ kind, onRetry, what }: { kind: "loading" | "forbidden" | "locked" | "plan" | "error"; onRetry?: () => void; what: string }) {
  if (kind === "loading")
    return (
      <div className="st" style={{ boxShadow: "none" }} aria-busy="true" aria-label="불러오는 중">
        <div className="lines">
          {[0, 1, 2].map((i) => (
            <span key={i} className="sk" style={{ height: 56 }} />
          ))}
        </div>
      </div>
    );
  const text = {
    forbidden: ["「쇼핑몰 설정」 권한 필요", "대표자에게 권한을 요청해 주십시오"],
    locked: ["이용 기간 종료", "구독하면 바로 다시 사용할 수 있습니다"],
    plan: ["지금 요금제에서 사용할 수 없는 기능", "쇼핑몰 운영이 포함된 요금제에서 사용할 수 있습니다"],
    error: [`${what}을 불러오지 못했습니다`, "잠시 뒤 다시 시도해 주십시오"],
  }[kind];
  return (
    <div className="st" style={{ boxShadow: "none" }}>
      <div className={`st-ic ${kind === "error" ? "neg" : "lock"}`}>!</div>
      <span className="t">{text[0]}</span>
      <span className="s">{text[1]}</span>
      {kind === "error" && onRetry && (
        <button className="btn btn-sm" type="button" onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}

export function stateKind(status: number, error?: string): "forbidden" | "locked" | "plan" | "error" {
  if (status === 402) return "locked";
  if (status === 403) return error === "plan_feature_required" ? "plan" : "forbidden";
  return "error";
}

export function ConfirmDelete({ title, body, busy, onCancel, onConfirm }: { title: string; body: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="sc-del-title">
      <div className="modal">
        <div className="modal-h">
          <h2 className="t-h2" id="sc-del-title">
            {title}
          </h2>
          <span className="t-l2 c-alt">{body}</span>
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button className="btn btn-neg" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? "삭제 중" : "삭제"}
          </button>
        </div>
      </div>
    </div>
  );
}

export const errorText = (r: { status: number; message?: string }, fallback: string) =>
  r.message ?? (r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오" : r.status === 403 ? "변경 권한이 없습니다" : r.status === 402 ? "이용 기간이 끝나 변경할 수 없습니다" : fallback);
