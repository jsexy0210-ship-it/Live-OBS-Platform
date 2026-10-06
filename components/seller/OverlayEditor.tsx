"use client";

import "./OverlayEditor.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUnsavedGuard } from "../../lib/client/navigation";
import { WidgetView } from "../overlay/WidgetView";
import { MAX_TEMPLATES, SAMPLE_DATA, SLOTS, STAGE, newWidget, slotOf, widgetLabel, type Aspect, type PropValue, type Widget } from "../overlay/layout";
import { PageHead, useConfirm } from "../admin-ui";
import { api, failMessage } from "./api";
import { Toast } from "./States";

// 오버레이 편집기(SA-051): 비율(9:16·16:9)마다 위젯 7종의 위치·크기(화면 대비 %)와 속성을 정해 저장한다.
// 저장은 expectedVersion으로: 다른 창에서 먼저 저장했으면 409 → 「다른 창에서 먼저 저장했습니다 · 다시 불러오기」.
// API: GET·PUT /api/seller/overlay/layout, POST …/layout/reset, GET·POST /api/seller/overlay/templates, DELETE …/templates/{id}
type Layout = { aspect: Aspect; templateKey: string; widgets: Widget[]; version: number; isDefault: boolean };
type Mine = { id: string; name: string; widgets: Widget[]; createdAt: string };
type Templates = { builtin: { key: string; name: string; widgets: Widget[] }[]; mine: Mine[] };
type Confirm = { text: string; detail?: string; ok: string; run: () => void };
const HISTORY_MAX = 50;

const stable = (w: Widget) => JSON.stringify(w, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const MIN_SIZE = 2;
const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

// 유튜브 화면 덮개 추정(세로 1080×1920 기준 px): 위 0~290 채널 정보, 960 아래는 채팅
type Guide = { p: number; k: "w" | "s" };
const SNAP_PCT = 1;
const COVER = { top: 290, chatFrom: 960 };

type Field =
  | { key: string; label: string; kind: "text"; max: number; lines?: boolean }
  | { key: string; label: string; kind: "num"; min: number; max: number; step: number; unit?: string }
  | { key: string; label: string; kind: "color" }
  | { key: string; label: string; kind: "bool" }
  | { key: string; label: string; kind: "appear" };
const color = (key: string, label: string): Field => ({ key, label, kind: "color" });
const fontFields: Field[] = [
  { key: "fontSize", label: "글자 크기", kind: "num", min: 8, max: 200, step: 1, unit: "px" },
  { key: "fontWeight", label: "글자 굵기", kind: "num", min: 100, max: 900, step: 100 },
  { key: "radius", label: "모서리", kind: "num", min: 0, max: 64, step: 1, unit: "px" },
];
const colorFields: Field[] = [
  color("titleColor", "제목 색"),
  color("nicknameColor", "닉네임 색"),
  color("bodyColor", "본문 색"),
  color("accentColor", "강조 색"),
  color("borderColor", "테두리 색"),
  color("titleBgColor", "제목 배경"),
  { key: "titleBgOpacity", label: "제목 배경 진하기", kind: "num", min: 0, max: 1, step: 0.05 },
  color("cardBgColor", "카드 배경"),
  { key: "cardBgOpacity", label: "카드 배경 진하기", kind: "num", min: 0, max: 1, step: 0.05 },
];
const queueColors: Field[] = [
  color("openTitleColor", "오픈 제목 색"),
  color("openNicknameColor", "오픈 닉네임 색"),
  color("openProductColor", "오픈 상품 색"),
  color("openBorderColor", "오픈 테두리 색"),
  color("waitTitleColor", "대기 제목 색"),
  color("waitNicknameColor", "대기 닉네임 색"),
  color("waitProductColor", "대기 상품 색"),
  color("waitBorderColor", "대기 테두리 색"),
  color("waitIndexColor", "대기 번호 색"),
  color("waitCountColor", "대기 건수 색"),
];
const effectFields: Field[] = [
  { key: "glow", label: "빛 번짐", kind: "bool" },
  { key: "appear", label: "나타나는 효과", kind: "appear" },
  { key: "appearSec", label: "나타나는 시간", kind: "num", min: 0, max: 10, step: 0.1, unit: "초" },
];
function contentFields(w: Widget): Field[] {
  const rows: Field = { key: "rows", label: "줄 수", kind: "num", min: 1, max: 10, step: 1 };
  const flow: Field = { key: "flowSec", label: "흐르는 시간", kind: "num", min: 1, max: 120, step: 1, unit: "초" };
  const title: Field = { key: "title", label: "제목", kind: "text", max: 40 };
  switch (w.type) {
    case "NOTICE":
      return [{ key: "text", label: "공지 글", kind: "text", max: 200, lines: true }, { key: "ticker", label: "옆으로 흐르기", kind: "bool" }, flow];
    case "SHOP_INFO":
      return [title, { key: "format", label: "문구 모양", kind: "text", max: 100 }];
    case "NEW_ORDER_ALERT":
      return [
        { key: "format", label: "문구 모양", kind: "text", max: 100 },
        { key: "durationSec", label: "표시 시간", kind: "num", min: 1, max: 30, step: 1, unit: "초" },
      ];
    case "QUEUE":
      return [title, rows];
    case "HALL_OF_FAME":
      return [title, rows, { key: "ticker", label: "위아래로 흐르기", kind: "bool" }, flow];
    case "CURRENT_ORDER":
      return [{ key: "marquee", label: "긴 닉네임 흐르기", kind: "bool" }, flow];
    case "OPEN_TIMER":
    case "EVENT_CARD":
      return [title];
    case "PURCHASE_RANKING":
      return [title, rows];
  }
}
const APPEAR: [string, string][] = [
  ["none", "없음"],
  ["fade", "서서히"],
  ["up", "아래에서"],
  ["left", "왼쪽에서"],
  ["flip", "뒤집기"],
];

// 입력 중에는 글자 그대로 두고, 값이 맞을 때만 바깥으로 알린다(비운 채로 두면 칸이 다시 채워지지 않게)
function NumInput({
  value,
  min,
  max,
  step,
  label,
  onCommit,
  testId,
}: {
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  label: string;
  onCommit: (n: number) => void;
  testId?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? "" : String(value));
  const bad = draft !== null && draft !== "" && !(Number.isFinite(Number(draft)) && Number(draft) >= min && Number(draft) <= max);
  return (
    <input
      className={`inp inp-sm ove-num${bad ? " is-err" : ""}`}
      type="number"
      aria-label={label}
      aria-invalid={bad || undefined}
      data-testid={testId}
      min={min}
      max={max}
      step={step}
      value={shown}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n) && n >= min && n <= max) onCommit(n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

function ColorInput({ value, label, onCommit }: { value: string | undefined; label: string; onCommit: (v: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value ?? "";
  const bad = draft !== null && draft !== "" && !COLOR_RE.test(draft);
  return (
    <span className="row" style={{ gap: 6 }}>
      <input type="color" className="ove-swatch" aria-label={`${label} 고르기`} value={value ? value.slice(0, 7) : "#000000"} onChange={(e) => onCommit(e.target.value)} />
      <input
        className={`inp inp-sm ove-hex${bad ? " is-err" : ""}`}
        aria-label={label}
        aria-invalid={bad || undefined}
        placeholder="기본"
        maxLength={9}
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value);
          if (COLOR_RE.test(e.target.value)) onCommit(e.target.value.toLowerCase());
          else if (e.target.value === "") onCommit(null);
        }}
        onBlur={() => setDraft(null)}
      />
    </span>
  );
}

function ConfirmDialog({ text, detail, ok, onOk, onClose }: { text: string; detail?: string; ok: string; onOk: () => void; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-label="확인">
      <div className="modal">
        <div className="modal-h">
          <h2 className="t-h2">{text}</h2>
          {detail && <span className="t-l2 c-alt">{detail}</span>}
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose}>
            취소
          </button>
          <button className="btn" type="button" onClick={onOk}>
            {ok}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OverlayEditor() {
  const [aspect, setAspect] = useState<Aspect>("9x16");
  const [server, setServer] = useState<Layout | null>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [templates, setTemplates] = useState<Templates | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState(true);
  const [guides, setGuides] = useState(true);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [tplName, setTplName] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const seq = useRef(0);
  // 되돌리기·다시 실행(50단계, 저장·다시 불러오기하면 비움). 같은 곳을 이어서 고치는 동안은 한 단계로 묶는다
  const hist = useRef({ past: [] as Widget[][], future: [] as Widget[][], key: "", t: 0 });
  const [, bump] = useState(0);
  const wref = useRef(widgets);
  wref.current = widgets;
  const mark = (key: string) => {
    const h = hist.current;
    const t = Date.now();
    const same = h.key === key && t - h.t < 800;
    h.key = key;
    h.t = t;
    if (same) return;
    h.past.push(wref.current);
    if (h.past.length > HISTORY_MAX) h.past.shift();
    h.future = [];
    bump((n) => n + 1);
  };
  const clearHistory = () => {
    hist.current = { past: [], future: [], key: "", t: 0 };
    bump((n) => n + 1);
  };
  const undo = () => {
    const h = hist.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(wref.current);
    h.key = "";
    setWidgets(prev);
    bump((n) => n + 1);
  };
  const redo = () => {
    const h = hist.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(wref.current);
    h.key = "";
    setWidgets(next);
    bump((n) => n + 1);
  };
  const [lines, setLines] = useState<{ v: Guide[]; h: Guide[] }>({ v: [], h: [] });
  const [fullPreview, setFullPreview] = useState(false);
  const [otherCount, setOtherCount] = useState(0);
  const [full, setFull] = useState(false);

  const { w: SW, h: SH } = STAGE[aspect];

  const load = useCallback(async (a: Aspect) => {
    const n = ++seq.current;
    setState("loading");
    const other = a === "9x16" ? "16x9" : "9x16";
    const [l, t, o] = await Promise.all([
      api<Layout>(`/api/seller/overlay/layout?aspect=${a}`),
      api<Templates>(`/api/seller/overlay/templates?aspect=${a}`),
      api<Templates>(`/api/seller/overlay/templates?aspect=${other}`),
    ]);
    if (n !== seq.current) return;
    if (!l.ok || !t.ok) return setState("error");
    setOtherCount(o.ok ? o.data.mine.length : 0);
    hist.current = { past: [], future: [], key: "", t: 0 };
    setServer(l.data);
    setWidgets(l.data.widgets);
    setTemplates(t.data);
    setSel(null);
    setConflict(false);
    setState("ok");
  }, []);
  useEffect(() => {
    void load(aspect);
  }, [aspect, load]);

  // 저장 안 한 변경 수: 바뀐 위젯 + 새로 켠 위젯 + 없앤 위젯
  const changes = (() => {
    if (!server) return 0;
    const before = new Map(server.widgets.map((w) => [w.id, stable(w)]));
    let n = widgets.filter((w) => before.get(w.id) !== stable(w)).length;
    n += server.widgets.filter((w) => !widgets.some((x) => x.id === w.id)).length;
    return n;
  })();
  // 저장 안 한 변경이 있으면 새로고침·탭 닫기·메뉴(앱 안 링크) 이동·브라우저 Back에 같은 확인(공통 미저장 가드, docs/IA.md 「Back · 상태 보존 규칙」 7항)
  useUnsavedGuard(changes > 0, `저장하지 않은 변경 ${changes}개가 있습니다. 나가면 바뀐 내용이 사라집니다. 나가시겠습니까?`);

  const patch = (id: string, p: Partial<Widget>) => {
    mark(`patch:${id}:${Object.keys(p).join()}:${Date.now()}`);
    setWidgets((cur) => cur.map((w) => (w.id === id ? { ...w, ...p } : w)));
  };
  const setProp = (id: string, key: string, v: PropValue | null) => {
    mark(`prop:${id}:${key}`);
    setWidgets((cur) =>
      cur.map((w) => {
        if (w.id !== id) return w;
        const props = { ...w.props };
        if (v === null) delete props[key];
        else props[key] = v;
        return { ...w, props };
      }),
    );
  };
  const setBox = (id: string, b: Partial<Pick<Widget, "x" | "y" | "w" | "h">>) =>
    setWidgets((cur) =>
      cur.map((w) => {
        if (w.id !== id) return w;
        const n = { ...w, ...b };
        n.w = clamp(n.w, MIN_SIZE, 100);
        n.h = clamp(n.h, MIN_SIZE, 100);
        n.x = clamp(n.x, 0, 100 - n.w);
        n.y = clamp(n.y, 0, 100 - n.h);
        return { ...n, x: round2(n.x), y: round2(n.y), w: round2(n.w), h: round2(n.h) };
      }),
    );

  // 입력 칸·방향키로 위치·크기를 바꿀 때(끌 때는 끌기를 시작할 때 한 번만 기록)
  const setBoxMarked = (id: string, b: Partial<Pick<Widget, "x" | "y" | "w" | "h">>, key: string) => {
    mark(`box:${id}:${key}`);
    setBox(id, b);
  };
  const toggle = (slot: (typeof SLOTS)[number], on: boolean) => {
    const cur = widgets.find((w) => slotOf(w).key === slot.key);
    if (cur) {
      patch(cur.id, { visible: on });
      if (on) setSel(cur.id);
      return;
    }
    if (!on) return;
    const w = newWidget(slot, aspect, widgets);
    mark(`add:${Date.now()}`);
    setWidgets([...widgets, w]);
    setSel(w.id);
  };

  // 앞뒤(위가 앞): z를 0부터 다시 매겨 서로 바꾼다
  const moveZ = (id: string, dir: 1 | -1) => {
    const order = [...widgets].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
    const i = order.findIndex((w) => w.id === id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    const z = new Map(order.map((w, k) => [w.id, k]));
    mark(`z:${Date.now()}`);
    setWidgets(widgets.map((w) => ({ ...w, z: z.get(w.id)! })));
  };

  // ---- 캔버스: 끌기·크기 조절·방향키 ----
  const canvas = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = col.current;
    if (!el) return;
    const fit = () => setScale(Math.min(el.clientWidth / SW, aspect === "9x16" ? 0.36 : 0.4));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [SW, aspect, state]);

  const drag = useRef<{ id: string; mode: string; sx: number; sy: number; o: Widget } | null>(null);
  const snapTo = (v: number) => (snap ? Math.round(v) : v);
  // 정렬 가이드: 다른 위젯 가장자리·가운데(분홍), 화면 가장자리·가운데·가림 영역 경계(주황)에 1% 안으로 다가가면 붙고 선을 보인다
  const near = (edges: number[], cands: Guide[]): { d: number; g: Guide } | null => {
    let best: { d: number; g: Guide } | null = null;
    for (const e of edges) for (const g of cands) if (Math.abs(g.p - e) <= SNAP_PCT && (!best || Math.abs(g.p - e) < Math.abs(best.d))) best = { d: g.p - e, g };
    return best;
  };
  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      const box = canvas.current?.getBoundingClientRect();
      if (!d || !box) return;
      const dx = ((e.clientX - d.sx) / box.width) * 100;
      const dy = ((e.clientY - d.sy) / box.height) * 100;
      const o = d.o;
      const others = wref.current.filter((w) => w.visible && w.id !== d.id);
      const xs: Guide[] = [0, 50, 100].map((p) => ({ p, k: "s" as const }));
      const ys: Guide[] = [0, 50, 100].map((p) => ({ p, k: "s" as const }));
      if (aspect === "9x16") ys.push({ p: (COVER.top / 1920) * 100, k: "s" }, { p: (COVER.chatFrom / 1920) * 100, k: "s" });
      for (const w of others) {
        xs.push(...[w.x, w.x + w.w / 2, w.x + w.w].map((p) => ({ p, k: "w" as const })));
        ys.push(...[w.y, w.y + w.h / 2, w.y + w.h].map((p) => ({ p, k: "w" as const })));
      }
      const gv: Guide[] = [];
      const gh: Guide[] = [];
      let { x, y, w, h } = o;
      if (d.mode === "move") {
        x = snapTo(clamp(o.x + dx, 0, 100 - o.w));
        y = snapTo(clamp(o.y + dy, 0, 100 - o.h));
        const sx = near([x, x + w / 2, x + w], xs);
        if (sx) {
          x = clamp(x + sx.d, 0, 100 - w);
          gv.push(sx.g);
        }
        const sy = near([y, y + h / 2, y + h], ys);
        if (sy) {
          y = clamp(y + sy.d, 0, 100 - h);
          gh.push(sy.g);
        }
      } else {
        if (d.mode.includes("e")) w = snapTo(clamp(o.w + dx, MIN_SIZE, 100 - o.x));
        if (d.mode.includes("s")) h = snapTo(clamp(o.h + dy, MIN_SIZE, 100 - o.y));
        if (d.mode.includes("w")) {
          x = snapTo(clamp(o.x + dx, 0, o.x + o.w - MIN_SIZE));
          w = o.x + o.w - x;
        }
        if (d.mode.includes("n")) {
          y = snapTo(clamp(o.y + dy, 0, o.y + o.h - MIN_SIZE));
          h = o.y + o.h - y;
        }
        // Shift: 가로세로 비율 유지(모서리만)
        if (e.shiftKey && d.mode.length === 2) {
          h = (w * o.h) / o.w;
          h = clamp(h, MIN_SIZE, d.mode.includes("n") ? o.y + o.h : 100 - o.y);
          if (d.mode.includes("n")) y = o.y + o.h - h;
        } else {
          if (d.mode.includes("e")) {
            const g = near([x + w], xs);
            if (g) {
              w = clamp(g.g.p - x, MIN_SIZE, 100 - x);
              gv.push(g.g);
            }
          }
          if (d.mode.includes("w")) {
            const g = near([x], xs);
            if (g) {
              const right = o.x + o.w;
              x = clamp(g.g.p, 0, right - MIN_SIZE);
              w = right - x;
              gv.push(g.g);
            }
          }
          if (d.mode.includes("s")) {
            const g = near([y + h], ys);
            if (g) {
              h = clamp(g.g.p - y, MIN_SIZE, 100 - y);
              gh.push(g.g);
            }
          }
          if (d.mode.includes("n")) {
            const g = near([y], ys);
            if (g) {
              const bottom = o.y + o.h;
              y = clamp(g.g.p, 0, bottom - MIN_SIZE);
              h = bottom - y;
              gh.push(g.g);
            }
          }
        }
      }
      setLines({ v: gv, h: gh });
      setBox(d.id, { x, y, w, h });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap, aspect],
  );
  const stop = useCallback(() => {
    drag.current = null;
    setLines({ v: [], h: [] });
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
  }, [onMove]);
  useEffect(() => stop, [stop]);
  const start = (e: React.PointerEvent, w: Widget, mode: string) => {
    e.preventDefault();
    e.stopPropagation();
    mark(`drag:${Date.now()}`);
    setSel(w.id);
    drag.current = { id: w.id, mode, sx: e.clientX, sy: e.clientY, o: w };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!sel || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!k) return;
    e.preventDefault();
    const px = e.shiftKey ? 10 : 1;
    const w = widgets.find((x) => x.id === sel);
    if (w) setBoxMarked(w.id, { x: w.x + (k[0]! * px * 100) / SW, y: w.y + (k[1]! * px * 100) / SH }, "key");
  };

  // Ctrl+Z 되돌리기 · Ctrl+Shift+Z(또는 Ctrl+Y) 다시 실행. 글자를 입력하는 칸에서는 브라우저 기본 동작을 둔다
  const undoRef = useRef({ undo, redo });
  undoRef.current = { undo, redo };
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) undoRef.current.undo();
      else if ((k === "z" && e.shiftKey) || k === "y") undoRef.current.redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  // ---- 저장·초기화·템플릿 ----
  const fail = (r: { status: number; message?: string; error?: string }) => {
    if (r.status === 409 && r.error === "version_conflict") return setConflict(true);
    setToast({ text: failMessage(r, "admin"), neg: true });
  };
  const apply = (l: Layout) => {
    setServer(l);
    setWidgets(l.widgets);
    setConflict(false);
    clearHistory();
  };
  const save = async (): Promise<boolean> => {
    if (!server || busy) return false;
    setBusy(true);
    const r = await api<Layout>("/api/seller/overlay/layout", { method: "PUT", body: { aspect, widgets, expectedVersion: server.version } });
    setBusy(false);
    if (!r.ok) {
      fail(r);
      return false;
    }
    apply(r.data);
    setToast({ text: "저장했습니다. 방송 화면이 바로 바뀝니다" });
    return true;
  };
  // 저장 버튼: 저장하면 방송 화면이 바로 바뀌므로 확인을 거친다(나가기 확인 창의 「저장하고 나가기」는 이미 확인을 거친 것이라 save를 바로 부른다)
  const { confirm: confirmSave } = useConfirm();
  const askSave = async () => {
    if (!server || busy) return;
    const ok = await confirmSave({
      title: "변경 사항을 저장하시겠습니까?",
      body: `${aspect === "9x16" ? "세로 9:16" : "가로 16:9"} 비율의 변경 ${changes}개를 저장합니다. 저장하면 방송 화면이 바로 바뀝니다.`,
      confirmLabel: "저장",
    });
    if (ok) await save();
  };
  // 템플릿으로 초기화: 지금 비율의 배치만 템플릿 값으로 바꾼다(저장하기 전까지는 초안이라 되돌리기로 가져올 수 있다)
  const askReset = (list: Widget[], name: string) =>
    setConfirm({
      text: `「${name}」 템플릿으로 바꾸시겠습니까?`,
      detail: `${aspect === "9x16" ? "세로 9:16" : "가로 16:9"} 비율의 위치·크기·색·효과가 이 템플릿 값으로 바뀝니다. 다른 비율은 그대로입니다. 저장하기 전까지는 「방금 작업 취소」로 되돌릴 수 있습니다.`,
      ok: "이 템플릿으로 바꾸기",
      run: () => {
        mark(`reset:${Date.now()}`);
        setWidgets(list);
        setSel(null);
        setToast({ text: "템플릿으로 초기화했습니다 · 저장하면 방송 화면에 반영됩니다" });
      },
    });
  const saveTemplate = async () => {
    const name = (tplName ?? "").trim();
    if (!name) return;
    setBusy(true);
    const r = await api<Mine>("/api/seller/overlay/templates", { method: "POST", body: { name, aspect, widgets } });
    setBusy(false);
    if (!r.ok) {
      setTplName(null);
      if (r.status === 409 && r.error === "too_many_templates") return setFull(true);
      return setToast({ text: failMessage(r, "admin"), neg: true });
    }
    setTemplates((t) => (t ? { ...t, mine: [r.data, ...t.mine] } : t));
    setTplName(null);
    setToast({ text: "내 템플릿으로 저장했습니다" });
  };
  const removeTemplate = async (m: Mine) => {
    const r = await api<unknown>(`/api/seller/overlay/templates/${m.id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) return setToast({ text: failMessage(r, "admin"), neg: true });
    setTemplates((t) => (t ? { ...t, mine: t.mine.filter((x) => x.id !== m.id) } : t));
    setFull(false);
    setToast({ text: "템플릿을 지웠습니다" });
  };
  const switchAspect = (a: Aspect) => {
    if (a === aspect) return;
    if (changes > 0) return setConfirm({ text: `저장 안 한 변경 ${changes}개가 사라집니다. 비율을 바꾸시겠습니까?`, ok: "비율 바꾸기", run: () => setAspect(a) });
    setAspect(a);
  };

  const total = (templates?.mine.length ?? 0) + otherCount;
  const selected = widgets.find((w) => w.id === sel) ?? null;
  const ordered = [...widgets].sort((a, b) => a.z - b.z);
  const listOrder = [...SLOTS].sort((a, b) => {
    const wa = widgets.find((w) => slotOf(w).key === a.key);
    const wb = widgets.find((w) => slotOf(w).key === b.key);
    return (wb ? wb.z + 1 : 0) - (wa ? wa.z + 1 : 0);
  });

  const head = (actions?: React.ReactNode) => <PageHead title="방송 화면 꾸미기" actions={actions} />;
  if (state === "loading" && !server)
    return (
      <>
        {head()}
        <div className="card pad" role="status" aria-busy="true">
          <span className="t-l2 c-alt">불러오는 중입니다</span>
        </div>
      </>
    );
  if (state === "error" && !server)
    return (
      <>
        {head()}
        <div className="card pad col" style={{ gap: 10 }} role="alert">
          <span className="t-l2">편집기를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 「다시 시도」를 눌러 주십시오.</span>
          <button className="btn btn-out" type="button" style={{ alignSelf: "flex-start" }} onClick={() => void load(aspect)}>
            다시 시도
          </button>
        </div>
      </>
    );

  const actions = (
    <>
      {changes > 0 && (
        <span className="ove-tag" data-testid="ove-dirty">
          저장 안 한 변경 {changes}개
        </span>
      )}
      <button className="btn btn-out" type="button" title="Ctrl+Z" disabled={hist.current.past.length === 0} onClick={undo}>
        방금 작업 취소
      </button>
      <button className="btn btn-out" type="button" title="Ctrl+Shift+Z" disabled={hist.current.future.length === 0} onClick={redo}>
        취소한 작업 다시 하기
      </button>
      <button className="btn btn-out" type="button" disabled={widgets.length === 0} onClick={() => setFullPreview(true)}>
        실제 크기로 보기
      </button>
      <button className="btn btn-out" type="button" disabled={busy || widgets.length === 0 || total >= MAX_TEMPLATES} onClick={() => setTplName("")}>
        지금 배치를 내 템플릿으로 저장
      </button>
      <button className="btn" type="button" disabled={busy || changes === 0} onClick={() => void askSave()}>
        방송 화면에 저장하기
      </button>
    </>
  );

  return (
    <>
    {head(actions)}
    <div className="col" style={{ gap: 12 }} data-testid="ove">
      <section className="card pad col" style={{ gap: 12 }} aria-label="화면 구성 편집">
        {conflict && (
          <div className="msg msg-neg row between" role="alert" data-testid="ove-conflict" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className="col" style={{ gap: 2 }}>
              <b>다른 창에서 먼저 저장해서 저장하지 못했습니다</b>
              <span>「최신 내용 불러오기」를 누른 뒤 다시 바꿔 주십시오. 지금 바꾼 내용은 「내 템플릿으로 저장」으로 남겨 둘 수 있습니다.</span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <button className="btn btn-sm btn-out" type="button" disabled={total >= MAX_TEMPLATES} onClick={() => setTplName("")}>
                내 템플릿으로 저장
              </button>
              <button className="btn btn-sm" type="button" onClick={() => void load(aspect)}>
                최신 내용 불러오기
              </button>
            </span>
          </div>
        )}

        <div className="ove-cols">
          <div className="ove-left col" style={{ gap: 20 }}>
          <div className="ove-list col" style={{ gap: 6 }}>
            <span className="t-l1 fw6">꾸미는 칸(글상자·카드)</span>
            <span className="t-c1 c-alt">위가 앞에 보입니다</span>
            <ul className="ove-slots" data-testid="ove-slots">
              {listOrder.map((s) => {
                const w = widgets.find((x) => slotOf(x).key === s.key);
                return (
                  <li key={s.key} className={`ove-slot${w && w.id === sel ? " is-sel" : ""}`}>
                    <label className="chk">
                      <input type="checkbox" aria-label={`${s.label} 보이기`} checked={!!w?.visible} onChange={(e) => toggle(s, e.target.checked)} />
                    </label>
                    <button className="ove-name" type="button" disabled={!w} onClick={() => w && setSel(w.id)}>
                      {s.label}
                    </button>
                    {w && (
                      <span className="row" style={{ gap: 2 }}>
                        <button className="btn btn-sm btn-out ove-z" type="button" aria-label={`${s.label} 앞으로`} onClick={() => moveZ(w.id, 1)}>
                          ▲
                        </button>
                        <button className="btn btn-sm btn-out ove-z" type="button" aria-label={`${s.label} 뒤로`} onClick={() => moveZ(w.id, -1)}>
                          ▼
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
      <section className="ove-sec col" style={{ gap: 8 }} aria-labelledby="ove-t">
        <h2 className="t-hl2" id="ove-t">
          템플릿
        </h2>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {templates?.builtin.map((t) => (
            <button key={t.key} className="btn btn-out" type="button" disabled={busy} onClick={() => askReset(t.widgets, t.name)}>
              {t.name}
            </button>
          ))}
        </div>
        {(full || total >= MAX_TEMPLATES) && (
          <div className="msg msg-cau" role="status" data-testid="ove-full">
            내 템플릿은 20개까지입니다. 하나를 지우면 저장할 수 있습니다
          </div>
        )}
        <table className="tbl ove-tbl" data-testid="ove-mine">
          <caption className="t-l2 c-alt" style={{ textAlign: "left", paddingBottom: 6 }}>
            내 템플릿 {total} / {MAX_TEMPLATES} · 비율마다 따로 저장되고 지금 비율({aspect === "9x16" ? "세로" : "가로"})에 저장한 것만 보입니다
          </caption>
          <thead>
            <tr>
              <th scope="col">이름</th>
              <th scope="col">관리</th>
            </tr>
          </thead>
          <tbody>
            {templates?.mine.length === 0 && (
              <tr>
                <td colSpan={2} className="c-alt">
                  저장한 템플릿이 없습니다
                </td>
              </tr>
            )}
            {templates?.mine.map((m) => (
              <tr key={m.id} data-testid="ove-mine-row">
                <td className="col-text">{m.name}</td>
                <td>
                  <span className="row" style={{ gap: 6, justifyContent: "center" }}>
                    <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => askReset(m.widgets, m.name)}>
                      이 템플릿으로 바꾸기
                    </button>
                    <button
                      className="btn btn-sm btn-out"
                      type="button"
                      aria-label={`${m.name} 지우기`}
                      onClick={() => setConfirm({ text: `「${m.name}」 템플릿을 지우시겠습니까?`, ok: "템플릿 지우기", run: () => void removeTemplate(m) })}
                    >
                      템플릿 지우기
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
          <section className="ove-sec col" style={{ gap: 8 }} aria-labelledby="ove-c">
            <h2 className="t-hl2" id="ove-c">
              캔버스
            </h2>
            <div className="ove-canvas-opts col" style={{ gap: 8 }}>
          <div className="seg" role="radiogroup" aria-label="비율">
            {(["9x16", "16x9"] as const).map((a) => (
              <button key={a} type="button" role="radio" aria-checked={aspect === a} className={aspect === a ? "on" : ""} onClick={() => switchAspect(a)}>
                {a === "9x16" ? "세로 9:16" : "가로 16:9"}
              </button>
            ))}
          </div>
          <label className="chk">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> 칸 맞추기(눈금에 붙이기)
          </label>
          {aspect === "9x16" && (
            <label className="chk">
              <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> 가려지는 곳 표시
            </label>
          )}
        </div>
          </section>
          </div>

          <div className="ove-center" ref={col}>
            <div
              className="ove-canvas"
              ref={canvas}
              tabIndex={0}
              role="application"
              aria-label="미리보기 화면입니다. 칸을 고른 뒤 방향키로 한 칸씩, Shift와 함께 누르면 열 칸씩 옮깁니다"
              data-testid="ove-canvas"
              style={{ width: SW * scale, height: SH * scale }}
              onKeyDown={onKey}
              onPointerDown={(e) => e.target === e.currentTarget && setSel(null)}
            >
              <div className="ove-stage" style={{ width: SW, height: SH, transform: `scale(${scale})` }}>
                {ordered
                  .filter((w) => w.visible)
                  .map((w) => (
                    <WidgetView key={w.id} widget={w} data={SAMPLE_DATA} now={0} editing />
                  ))}
              </div>
              {aspect === "9x16" && guides && (
                <>
                  <div className="ove-cover" style={{ top: 0, height: `${(COVER.top / SH) * 100}%` }}>
                    <span>유튜브 채널 정보</span>
                  </div>
                  <div className="ove-cover" style={{ top: `${(COVER.chatFrom / SH) * 100}%`, bottom: 0 }}>
                    <span>유튜브 채팅</span>
                  </div>
                </>
              )}
              {lines.v.map((g, i) => (
                <i key={`v${i}`} className={`ove-gl ove-gl-v ove-gl-${g.k}`} data-testid="ove-guide" style={{ left: `${g.p}%` }} />
              ))}
              {lines.h.map((g, i) => (
                <i key={`h${i}`} className={`ove-gl ove-gl-h ove-gl-${g.k}`} data-testid="ove-guide" style={{ top: `${g.p}%` }} />
              ))}
              {ordered
                .filter((w) => w.visible)
                .map((w) => (
                  <div
                    key={w.id}
                    className={`ove-hit${w.id === sel ? " is-sel" : ""}`}
                    data-testid={`ove-box-${w.id}`}
                    aria-label={widgetLabel(w)}
                    style={{ left: `${w.x}%`, top: `${w.y}%`, width: `${w.w}%`, height: `${w.h}%`, zIndex: 10 + w.z }}
                    onPointerDown={(e) => start(e, w, "move")}
                  >
                    {w.id === sel &&
                      ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((m) => <i key={m} className={`ove-h ove-h-${m}`} data-testid={`ove-handle-${m}`} onPointerDown={(e) => start(e, w, m)} />)}
                  </div>
                ))}
            </div>
            <span className="t-c1 c-alt">
              {SW}×{SH} 기준 · 끌어서 옮기고 모서리를 끌어 크기를 바꿉니다. Shift를 누르고 모서리를 끌면 가로세로 비율이 그대로입니다
            </span>
          </div>

          <div className="ove-props col" style={{ gap: 10 }} data-testid="ove-props">
            {!selected ? (
              <span className="t-l2 c-alt">미리보기 화면이나 왼쪽 목록에서 칸을 선택해 주십시오.</span>
            ) : (
              <>
                <span className="t-l1 fw6">{widgetLabel(selected)}</span>
                {/* 보드(SA-051) 순서: 내용 → 위치·크기 → 글자 → 색 → 효과 */}
                {(
                  [
                    ["내용", contentFields(selected)],
                    ["위치·크기", null],
                    ["글자", fontFields],
                    ["색", [...colorFields, ...(selected.type === "QUEUE" ? queueColors : [])]],
                    ["효과", effectFields],
                  ] as [string, Field[] | null][]
                ).map(([title, fields]) =>
                  fields === null ? (
                    <fieldset key={title} className="ove-fs">
                      <legend>위치·크기 (화면 대비 %)</legend>
                      {(["x", "y", "w", "h"] as const).map((k) => (
                        <label key={k} className="ove-fr">
                          <span>{{ x: "가로 위치", y: "세로 위치", w: "너비", h: "높이" }[k]}</span>
                          <NumInput
                            label={{ x: "가로 위치", y: "세로 위치", w: "너비", h: "높이" }[k]}
                            value={selected[k]}
                            min={k === "w" || k === "h" ? MIN_SIZE : 0}
                            max={100}
                            step={0.1}
                            onCommit={(n) => setBoxMarked(selected.id, { [k]: n }, k)}
                          />
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <fieldset key={title} className="ove-fs">
                      <legend>{title}</legend>
                      {fields.map((f) => (
                        <PropRow key={f.key} f={f} w={selected} onSet={(v) => setProp(selected.id, f.key, v)} />
                      ))}
                    </fieldset>
                  ),
                )}
              </>
            )}
          </div>
        </div>
      </section>

      {confirm && (
        <ConfirmDialog
          text={confirm.text}
          detail={confirm.detail}
          ok={confirm.ok}
          onClose={() => setConfirm(null)}
          onOk={() => {
            const run = confirm.run;
            setConfirm(null);
            run();
          }}
        />
      )}
      {tplName !== null && (
        <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="ove-tn-h">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void saveTemplate();
            }}
          >
            <div className="modal-h">
              <h2 className="t-h2" id="ove-tn-h">
                내 템플릿으로 저장
              </h2>
              <input className="inp" aria-label="템플릿 이름" placeholder="템플릿 이름 (30자 이내)" maxLength={30} autoFocus value={tplName} onChange={(e) => setTplName(e.target.value)} />
            </div>
            <div className="modal-f">
              <button className="btn btn-out" type="button" onClick={() => setTplName(null)}>
                취소
              </button>
              <button className="btn" type="submit" disabled={busy || !tplName.trim()}>
                저장
              </button>
            </div>
          </form>
        </div>
      )}
      {fullPreview && <FullPreview widgets={widgets} aspect={aspect} onClose={() => setFullPreview(false)} />}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </div>
    </>
  );
}

function PropRow({ f, w, onSet }: { f: Field; w: Widget; onSet: (v: PropValue | null) => void }) {
  const cur = w.props[f.key];
  const reset = cur !== undefined && (
    <button className="ove-clear" type="button" aria-label={`${f.label} 처음 값으로`} onClick={() => onSet(null)}>
      처음 값으로
    </button>
  );
  return (
    <div className="ove-fr">
      <span>{f.label}</span>
      <span className="row" style={{ gap: 6 }}>
        {f.kind === "num" && (
          <>
            <NumInput label={f.label} value={typeof cur === "number" ? cur : undefined} min={f.min} max={f.max} step={f.step} onCommit={(n) => onSet(n)} />
            {f.unit && <span className="t-c1 c-alt">{f.unit}</span>}
          </>
        )}
        {f.kind === "text" &&
          (f.lines ? (
            <textarea
              className="inp ove-txt"
              aria-label={f.label}
              maxLength={f.max}
              value={typeof cur === "string" ? cur : ""}
              onChange={(e) => onSet(e.target.value === "" ? null : e.target.value)}
            />
          ) : (
            <input
              className="inp inp-sm ove-txt"
              aria-label={f.label}
              maxLength={f.max}
              value={typeof cur === "string" ? cur : ""}
              onChange={(e) => onSet(e.target.value === "" ? null : e.target.value)}
            />
          ))}
        {f.kind === "color" && <ColorInput label={f.label} value={typeof cur === "string" ? cur : undefined} onCommit={onSet} />}
        {f.kind === "bool" && (
          <label className="chk">
            <input type="checkbox" aria-label={f.label} checked={cur === true} onChange={(e) => onSet(e.target.checked ? true : null)} />
          </label>
        )}
        {f.kind === "appear" && (
          <select className="inp inp-sm" aria-label={f.label} value={typeof cur === "string" ? cur : "none"} onChange={(e) => onSet(e.target.value === "none" ? null : e.target.value)}>
            {APPEAR.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        )}
        {f.kind !== "bool" && f.kind !== "appear" && reset}
      </span>
    </div>
  );
}

// 실제 크기 미리보기: 오버레이 화면과 같은 렌더러로 1배 크기(1080×1920 · 1920×1080)를 그린다. 창보다 크면 스크롤한다
function FullPreview({ widgets, aspect, onClose }: { widgets: Widget[]; aspect: Aspect; onClose: () => void }) {
  const { w, h } = STAGE[aspect];
  const [now] = useState(() => Date.now());
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="dim dim-fixed ove-full" role="dialog" aria-modal="true" aria-label="실제 크기로 보기" data-testid="ove-fullpreview">
      <div className="ove-full-bar">
        <span className="t-l1 fw6">
          실제 크기로 보기 · {w}×{h}
        </span>
        <button className="btn btn-sm" type="button" autoFocus onClick={onClose}>
          닫기
        </button>
      </div>
      <div className="ove-full-scroll">
        <div className="ove-full-stage" style={{ width: w, height: h }}>
          {[...widgets]
            .filter((x) => x.visible)
            .sort((a, b) => a.z - b.z)
            .map((x) => (
              <WidgetView key={x.id} widget={x} data={SAMPLE_DATA} now={now} />
            ))}
        </div>
      </div>
    </div>
  );
}
