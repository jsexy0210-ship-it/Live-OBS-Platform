"use client";

import Link from "next/link";
import { apiUpload } from "../../../../../../components/seller/api";
import { useRef, useState } from "react";
import { normalizeLink, resolveLink } from "../../../../../../lib/server/shop-content/link";
import "./shop-content.css";
import { formatDateTime } from "../../../../../../lib/client/format";
import { DateTimePicker } from "../../../../../../components/admin-ui/DatePicker";

// 홈 배너 관리(SA-064)·이벤트 팝업 관리(SA-065)가 함께 쓰는 화면 조각. 파트너스 관리자 문구는 명사형·합니다체(2026-10-04 대표님 지시).

export type ContentStatus = "live" | "scheduled" | "ended" | "hidden";
export type AdminImage = { id: string; width: number; height: number; url: string };

const STATUS: Record<ContentStatus, { label: string; cls: string }> = {
  live: { label: "게시 중", cls: "b-done" },
  scheduled: { label: "예약", cls: "b-info" },
  ended: { label: "종료", cls: "b-gray nodot" },
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

export const kstText = (iso: string | null): string => formatDateTime(iso);

export function periodText(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt && !endsAt) return "상시";
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
        <DateTimePicker aria-label="시작 시각" value={startsAt} disabled={disabled} onChange={(v) => onChange({ startsAt: v, endsAt })} />
        <span className="c-alt">~</span>
        <DateTimePicker aria-label="종료 시각" value={endsAt} disabled={disabled} onChange={(v) => onChange({ startsAt, endsAt: v })} />
      </div>
      {bad ? <span className="err">종료 시각은 시작 시각보다 늦어야 합니다</span> : <span className="help">비우면 바로 게시 · 종료를 비우면 상시 · 서버 시각 기준 자동 게시·숨김</span>}
    </div>
  );
}

// ───────── 이미지 올리기 ─────────
// 상자 자체가 올리는 곳이다(누르거나 끌어다 놓기, 미리보기, 바꾸기·지우기). PNG만, 2MB 이하(서버가 바이트로 확인).
const IMAGE_ERRORS: Record<string, string> = {
  file_too_large: "이미지는 2MB까지 올릴 수 있습니다",
  unsupported_image: "PNG 파일만 올릴 수 있습니다",
  wrong_image_size: "이미지 가로·세로는 100~2000px, 전체 1920×1080 화소 이하여야 합니다",
  empty_file: "빈 파일은 올릴 수 없습니다",
  png_16bit: "8비트(일반) PNG로 저장해 주십시오. 16비트 PNG는 올릴 수 없습니다",
  png_too_large: "이미지 데이터가 너무 큽니다. 8비트(일반) PNG로 저장하거나 크기를 줄여 주십시오",
};
const MAX_BYTES = 2 * 1024 * 1024;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

export function ImagePicker({
  label,
  recommend,
  value,
  onChange,
  optional,
  emptyHint,
  disabled,
  onBusy,
  frame,
}: {
  label: string;
  recommend: { width: number; height: number };
  value: AdminImage | null;
  onChange: (v: AdminImage | null) => void;
  optional?: boolean;
  emptyHint?: string;
  disabled?: boolean;
  // 올리는 동안 true. 편집 화면은 이 동안 저장을 막는다(옛 이미지로 저장되지 않게).
  onBusy?: (busy: boolean) => void;
  // 표형 입력 화면(SA-064 정본 .up): 정해진 크기의 칸 안에서 올리고, 이미지 위에 「바꾸기」「지우기」가 겹쳐 보인다. 칸 아래에 안내 한 줄.
  frame?: { width: number; height: number; hint: string };
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 올리는 중에는 새 파일(끌어 놓기 포함)을 받지 않는다. 잇단 끌어 놓기는 다음 렌더 전이라 ref로 막는다(순서 뒤바뀜·busy 조기 해제 방지).
  const working = useRef(false);

  const upload = async (file: File) => {
    // 고른 파일은 이미 받았으니 입력 칸을 바로 비운다. 화면에서 거절(2MB 초과 등)해도 같은 파일을 다시 고를 수 있다(Codex 4176481022).
    if (input.current) input.current.value = "";
    if (working.current) return;
    setError(null);
    // 서버도 다시 확인한다. 큰 파일은 보내기 전에 알려 준다.
    if (file.size > MAX_BYTES) return setError(`2MB를 넘었습니다 · 지금 파일은 ${mb(file.size)}입니다`);
    working.current = true;
    setBusy(true);
    onBusy?.(true);
    // 파일 바이트를 그대로 보낸다. 형식은 서버가 바이트로 확인한다. 로그인이 풀렸으면 apiUpload가 로그인 화면으로 보낸다.
    const r = await apiUpload<{ image: AdminImage }>("/api/seller/shop-content/images", file);
    working.current = false;
    setBusy(false);
    onBusy?.(false);
    if (r.ok) onChange(r.data.image);
    else if (r.status !== 401)
      setError(r.message ?? IMAGE_ERRORS[r.error] ?? (r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오" : r.status === 403 ? "변경 권한이 없습니다" : "이미지를 올리지 못했습니다"));
  };

  const small = value && (value.width < recommend.width || value.height < recommend.height);
  const pick = () => !disabled && !busy && input.current?.click();

  if (frame) {
    return (
      <div className="sc-up-wrap">
        <div
          className={`sc-up${over ? " is-over" : ""}${value ? " has-img" : ""}`}
          style={{ width: frame.width, height: frame.height }}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label={`${label} ${value ? "바꾸기" : "올리기"}`}
          aria-busy={busy}
          onClick={pick}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick())}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !disabled && !busy) void upload(f);
          }}
        >
          {value ? (
            <>
              <img src={value.url} alt="" className="sc-up-img" />
              <span className="sc-up-ov">
                <button className="btn btn-sm btn-out" type="button" disabled={disabled || busy} onClick={(e) => (e.stopPropagation(), pick())}>
                  {busy ? "올리는 중" : "바꾸기"}
                </button>
                {optional && (
                  <button className="btn btn-sm btn-out" type="button" disabled={disabled || busy} onClick={(e) => (e.stopPropagation(), onChange(null))}>
                    지우기
                  </button>
                )}
              </span>
            </>
          ) : (
            <span className="sc-up-empty">
              <b>+</b>
              <span>{busy ? "올리는 중" : `${label} 올리기`}</span>
              <span className="sc-up-rec">
                {recommend.width} × {recommend.height} 권장 · PNG · 2MB 이하
              </span>
            </span>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png"
          hidden
          aria-label={label}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        {error ? (
          <span className="err" role="alert">
            {error}
          </span>
        ) : small ? (
          <span className="help">
            가로 {recommend.width}px 이상 이미지를 권장합니다 · 지금 파일은 {value!.width}×{value!.height}입니다 (올릴 수는 있음)
          </span>
        ) : (
          <span className="help">{frame.hint}</span>
        )}
      </div>
    );
  }

  return (
    <div className="fld">
      <span className={optional ? "lbl" : "lbl req"}>{label}</span>
      <div
        className={`sc-drop${over ? " is-over" : ""}${value ? " has-img" : ""}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label} ${value ? "바꾸기" : "선택"}`}
        aria-busy={busy}
        onClick={pick}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick())}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !disabled && !busy) void upload(f);
        }}
      >
        {value ? (
          <img src={value.url} alt="" className="sc-drop-img" />
        ) : (
          <span className="col" style={{ alignItems: "center", gap: 4 }}>
            <span className="t-l2 fw6">{busy ? "올리는 중" : "이미지를 끌어다 놓거나 선택"}</span>
            <span className="t-c1 c-alt">
              8비트 PNG · 2MB 이하 · {recommend.width} × {recommend.height} 권장
            </span>
          </span>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png"
        hidden
        aria-label={label}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      {value && (
        <div className="row between" style={{ gap: 8 }}>
          <span className="t-c1 c-alt num">
            {value.width} × {value.height}px · PNG
          </span>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm btn-out" type="button" disabled={disabled || busy} onClick={pick}>
              {busy ? "올리는 중" : "바꾸기"}
            </button>
            {optional && (
              <button className="btn btn-sm btn-ghost" type="button" disabled={disabled || busy} onClick={() => onChange(null)}>
                지우기
              </button>
            )}
          </span>
        </div>
      )}
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : small ? (
        <span className="help">
          가로 {recommend.width}px 이상 이미지를 권장합니다 · 지금 파일은 {value!.width}×{value!.height}입니다 (올릴 수는 있음)
        </span>
      ) : (
        !value && emptyHint && <span className="help">{emptyHint}</span>
      )}
    </div>
  );
}

// ───────── 탭 · 기기 · 요약 ─────────
export function ContentTabs({ active }: { active: "banners" | "popups" }) {
  const tabs = [
    { key: "banners", href: "/seller/banners", label: "홈 배너" },
    { key: "popups", href: "/seller/banners/popups", label: "이벤트 팝업" },
  ] as const;
  return (
    <nav className="tabs" aria-label="배너 · 팝업">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={`tab${active === t.key ? " on" : ""}`} aria-current={active === t.key ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

type Devices = { showOnPc: boolean; showOnMobile: boolean };
const DEVICE_CHOICES: { label: string; v: Devices }[] = [
  { label: "PC · 모바일", v: { showOnPc: true, showOnMobile: true } },
  { label: "PC만", v: { showOnPc: true, showOnMobile: false } },
  { label: "모바일만", v: { showOnPc: false, showOnMobile: true } },
];
export const devicesText = (d: Devices) => DEVICE_CHOICES.find((c) => c.v.showOnPc === d.showOnPc && c.v.showOnMobile === d.showOnMobile)?.label ?? "PC · 모바일";

export function DeviceSeg({ value, onChange }: { value: Devices; onChange: (v: Devices) => void }) {
  return (
    <div className="fld">
      <span className="lbl" id="sc-device-label">
        표시 기기
      </span>
      <div className="seg" role="radiogroup" aria-labelledby="sc-device-label" style={{ alignSelf: "flex-start" }}>
        {DEVICE_CHOICES.map((c) => {
          const on = c.v.showOnPc === value.showOnPc && c.v.showOnMobile === value.showOnMobile;
          return (
            <button key={c.label} type="button" role="radio" aria-checked={on} className={on ? "on" : ""} onClick={() => onChange(c.v)}>
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StatusSummary({ noun, unit, list }: { noun: string; unit: string; list: { status: ContentStatus }[] }) {
  const n = (s: ContentStatus) => list.filter((i) => i.status === s).length;
  return (
    <div className="row" style={{ gap: 8, flexWrap: "wrap", padding: "14px 20px", boxShadow: "inset 0 -1px 0 var(--wds-line-normal-alternative)" }}>
      <span className="t-hl2">
        {noun} {list.length}
        {unit}
      </span>
      {n("live") > 0 && <span className="bdg b-done">게시 중 {n("live")}</span>}
      {n("scheduled") > 0 && <span className="bdg b-info">예약 {n("scheduled")}</span>}
      {n("hidden") > 0 && <span className="bdg b-cancel">숨김 {n("hidden")}</span>}
      {n("ended") > 0 && <span className="bdg b-gray nodot">종료 {n("ended")}</span>}
    </div>
  );
}

// 편집 화면의 이미지 올리기 진행 수. 하나라도 올리는 중이면 저장을 막는다.
export function useUploading() {
  const [n, setN] = useState(0);
  return { uploading: n > 0, onBusy: (b: boolean) => setN((v) => Math.max(0, v + (b ? 1 : -1))) };
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

// 미리보기 링크: 입력값을 구매자 화면과 같은 규칙으로 바꾼다(잘못된 값은 링크 없음).
export function previewLink(slug: string, raw: string) {
  const n = normalizeLink(raw);
  return n.ok ? resolveLink(slug, n.value) : null;
}

// 미리보기 안에서는 링크를 눌러도 이동하지 않는다.
export function PreviewFrame({ children, ...rest }: { children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} onClickCapture={(e) => (e.target as HTMLElement).closest("a") && e.preventDefault()}>
      {children}
    </div>
  );
}
