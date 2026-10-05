"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal, PageHead } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { StateBox, errorText, kstText, stateKind } from "../banners/_shared/ui";
import "./member-messages.css";

// SA-049 회원 알림 발송(파트너스 관리자, 고객 › 회원 알림 발송). 실제 발송 채널(알림톡·문자·메일)과 충전 잔액 차감은 정해지기 전이라 발송 「기록」만 남긴다.
// 광고성은 수신 동의 회원만·(광고)·무료 수신거부 자동 삽입·08~21시·같은 회원 하루 2건. 조회·발송은 대표자 · 회원/적립금(MEMBER_POINTS) 권한 직원. API: /api/seller/member-messages.
type Kind = "AD" | "INFO";
type Channel = "ALIMTALK_SMS" | "ALIMTALK" | "MAIL";
type TargetType = "ALL" | "GRADE" | "WISHED" | "BOUGHT_30D" | "NOT_BOUGHT_90D" | "PRODUCT_BOUGHT" | "PICKED";
type Msg = {
  id: string;
  title: string;
  kind: Kind;
  channel: Channel;
  channelLabel: string;
  body: string;
  renderedBody: string;
  targetType: TargetType;
  status: "SCHEDULED" | "RECORDED" | "CANCELLED";
  scheduledAt: string | null;
  recordedAt: string | null;
  estimatedCount: number;
  recipientCount: number | null;
  skippedDailyCap: number;
};
type Summary = {
  consented: number;
  activeMembers: number;
  consentedPercent: number | null;
  monthRecorded: number;
  monthAlimtalk: number;
  monthMail: number;
  orders24h: number;
  orders24hAmount: number;
  withdrawn30: number;
  withdrawn30Percent: number | null;
};
type Data = { messages: Msg[]; nextCursor: string | null; summary: Summary };
type Preview = { matched: number; consented: number; noConsent: number; dailyCapped: number; finalCount: number; sendAt: string; immediate: boolean; rescheduled: boolean; renderedBody: string; longMessage: boolean };
type Detail = Msg & { orders24h: { count: number; amount: number } | null };
type Grade = { id: string; displayName: string };
type Product = { id: string; name: string };
type Found = { id: string; broadcastNickname: string };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const TARGETS: { v: TargetType; label: string }[] = [
  { v: "ALL", label: "전체 회원" },
  { v: "GRADE", label: "등급" },
  { v: "WISHED", label: "찜한 회원" },
  { v: "BOUGHT_30D", label: "최근 30일 구매" },
  { v: "NOT_BOUGHT_90D", label: "최근 90일 미구매" },
  { v: "PRODUCT_BOUGHT", label: "특정 상품 구매" },
  { v: "PICKED", label: "직접 선택" },
];
const CHANNELS: { v: Channel; label: string }[] = [
  { v: "ALIMTALK_SMS", label: "알림톡 (실패 시 문자)" },
  { v: "ALIMTALK", label: "알림톡만" },
  { v: "MAIL", label: "메일" },
];
const STATUS = { SCHEDULED: { label: "예약", cls: "b-pending" }, RECORDED: { label: "기록됨", cls: "b-done" }, CANCELLED: { label: "취소", cls: "b-gray nodot" } } as const;
const targetLabel = (t: TargetType) => TARGETS.find((x) => x.v === t)?.label ?? t;
// datetime-local(KST 입력) → ISO
const toIso = (v: string) => new Date(`${v}:00+09:00`).toISOString();
const toLocal = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16);

export default function MemberMessagesPage() {
  const { can } = useSeller();
  const canEdit = can("MEMBER_POINTS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [tab, setTab] = useState<"list" | "new">("list");
  const [toast, setToast] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);

  const load = useCallback(async () => {
    const r = await api<Data>("/api/seller/member-messages");
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", data: r.data });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const data = state.kind === "ok" ? state.data : null;

  const open = async (m: Msg) => {
    const r = await api<{ message: Detail }>(`/api/seller/member-messages/${m.id}`);
    if (r.ok) setDetail(r.data.message);
  };
  const cancel = async (m: Msg) => {
    const r = await api(`/api/seller/member-messages/${m.id}/cancel`, { method: "POST", body: {} });
    setToast(r.ok ? "예약을 취소했습니다" : errorText(r, "취소하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    await load();
  };

  return (
    <>
      <Topbar crumb="고객 › 회원 알림 발송" />
      <main className="main">
        <PageHead
          title="회원 알림 발송"
          actions={
            data && canEdit ? (
              <button className="btn" type="button" onClick={() => setTab("new")}>
                새 발송
              </button>
            ) : undefined
          }
        />
        <div className="msg msg-info" role="status">
          <span>실제 발송 채널(알림톡 · 문자 · 메일)이 아직 연결되지 않아 발송 기록만 남습니다. 충전 잔액은 차감되지 않으며, 채널이 정해지면 같은 기록으로 발송합니다.</span>
        </div>
        {state.kind === "loading" && <StateBox kind="loading" what="회원 알림 발송" />}
        {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="회원 알림 발송" onRetry={() => void load()} />}
        {data && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>보기만 할 수 있습니다. 발송은 대표자나 회원 · 적립금 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        {data && (
          <>
            <section className="card mm-sum" aria-label="요약" data-testid="mm-summary">
              <div>
                <span className="t-l2 c-alt">혜택 · 소식 동의</span>
                <b className="num">{data.summary.consented.toLocaleString("ko-KR")}명</b>
                <span className="t-c1 c-alt">{data.summary.consentedPercent === null ? "-" : `전체 회원의 ${data.summary.consentedPercent}%`}</span>
              </div>
              <div>
                <span className="t-l2 c-alt">이번 달 기록</span>
                <b className="num">{data.summary.monthRecorded.toLocaleString("ko-KR")}건</b>
              </div>
              <div>
                <span className="t-l2 c-alt">알림톡 · 메일</span>
                <b className="num">
                  {data.summary.monthAlimtalk.toLocaleString("ko-KR")} · {data.summary.monthMail.toLocaleString("ko-KR")}
                </b>
              </div>
              <div>
                <span className="t-l2 c-alt">발송 뒤 24시간 주문</span>
                <b className="num">
                  {data.summary.orders24h}건 · {won(data.summary.orders24hAmount)}
                </b>
              </div>
              <div>
                <span className="t-l2 c-alt">수신 거부 (30일)</span>
                <b className="num">
                  {data.summary.withdrawn30}명{data.summary.withdrawn30Percent === null ? "" : ` · ${data.summary.withdrawn30Percent}%`}
                </b>
              </div>
            </section>
            <div className="tabs" role="tablist">
              <button className={`tab${tab === "list" ? " on" : ""}`} type="button" role="tab" aria-selected={tab === "list"} onClick={() => setTab("list")}>
                발송 내역
              </button>
              {canEdit && (
                <button className={`tab${tab === "new" ? " on" : ""}`} type="button" role="tab" aria-selected={tab === "new"} onClick={() => setTab("new")}>
                  새 발송
                </button>
              )}
            </div>
            {tab === "list" && (
              <section className="card" style={{ overflow: "hidden" }} aria-label="발송 내역">
                <div className="mm-row mm-head">
                  <span>제목 · 대상</span>
                  <span className="mm-hide-m">채널</span>
                  <span className="mm-hide-m">발송 시각</span>
                  <span className="mm-hide-m">받는 사람</span>
                  <span>상태</span>
                  <span className="mm-hide-m">관리</span>
                </div>
                {data.messages.length === 0 ? (
                  <div className="st" style={{ boxShadow: "none" }}>
                    <span className="t">발송 내역이 없습니다</span>
                    <span className="s">「새 발송」에서 대상과 문구를 정해 기록해 보십시오</span>
                  </div>
                ) : (
                  data.messages.map((m) => (
                    <div key={m.id} className="mm-row" data-testid="mm-item">
                      <span className="col" style={{ gap: 2, minWidth: 0 }}>
                        <span className="t-l2 fw6 ell">{m.title}</span>
                        <span className="t-c1 c-alt">
                          {m.kind === "AD" ? "광고성" : "정보성"} · {targetLabel(m.targetType)}
                        </span>
                      </span>
                      <span className="mm-hide-m t-l2">{m.channelLabel}</span>
                      <span className="mm-hide-m t-c1 c-alt num">{kstText(m.recordedAt ?? m.scheduledAt ?? "").slice(5, 16)}</span>
                      <span className="mm-hide-m t-l2 num">{m.recipientCount ?? m.estimatedCount}명</span>
                      <span>
                        <span className={`bdg ${STATUS[m.status].cls}`}>{STATUS[m.status].label}</span>
                      </span>
                      <span className="mm-hide-m row" style={{ gap: 6 }}>
                        <button className="btn btn-sm btn-text" type="button" onClick={() => void open(m)}>
                          보기
                        </button>
                        {canEdit && m.status === "SCHEDULED" && (
                          <>
                            <button className="btn btn-sm btn-text" type="button" onClick={() => setEditing(m)}>
                              수정
                            </button>
                            <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} onClick={() => void cancel(m)}>
                              취소
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </section>
            )}
            {tab === "new" && canEdit && (
              <NewMessage
                onDone={async (text) => {
                  setToast(text);
                  setTab("list");
                  await load();
                }}
              />
            )}
            <section className="card pad col" style={{ gap: 8 }} aria-label="법규 · 운영 규칙">
              <span className="t-hl2">법규 · 운영 규칙</span>
              <div className="mm-rules t-l2">
                <span className="c-alt">수신 동의</span>
                <span>광고성은 혜택 · 소식 동의 회원만 · 미동의 자동 제외 · 정보성은 정상 회원 전체</span>
                <span className="c-alt">표기</span>
                <span>(광고) · 쇼핑몰 이름 · 무료 수신거부 자동 삽입</span>
                <span className="c-alt">시간</span>
                <span>광고성 08~21시 · 정보성은 제한 없음 · 시간 밖에 「지금」을 고르면 다음 08:00에 예약</span>
                <span className="c-alt">빈도</span>
                <span>같은 회원 하루 2건까지 · 넘는 회원은 자동 제외</span>
                <span className="c-alt">기록</span>
                <span>발송 · 대상 · 문구는 로그 추적에 남음</span>
              </div>
            </section>
          </>
        )}
      </main>
      {detail && <DetailModal d={detail} onClose={() => setDetail(null)} />}
      {editing && (
        <EditModal
          m={editing}
          onClose={() => setEditing(null)}
          onDone={async () => {
            setEditing(null);
            setToast("예약을 수정했습니다");
            await load();
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

function DetailModal({ d, onClose }: { d: Detail; onClose: () => void }) {
  return (
    <Modal labelId="mm-detail-title" onClose={onClose}>
      <div className="modal-h">
        <h2 className="modal-t" id="mm-detail-title">
          {d.title}
        </h2>
      </div>
      <div className="modal-b col" style={{ gap: 10 }}>
        <div className="mm-bubble" data-testid="mm-body">
          {d.renderedBody}
        </div>
        <div className="mm-rules t-l2">
          <span className="c-alt">상태</span>
          <span>{d.status === "RECORDED" ? "기록됨 (실제 발송 전)" : d.status === "SCHEDULED" ? `예약 ${kstText(d.scheduledAt ?? "")}` : "취소"}</span>
          <span className="c-alt">채널</span>
          <span>{d.channelLabel}</span>
          <span className="c-alt">받는 사람</span>
          <span className="num">
            {d.recipientCount ?? d.estimatedCount}명{d.skippedDailyCap > 0 ? ` (하루 2건 한도로 ${d.skippedDailyCap}명 제외)` : ""}
          </span>
          {d.orders24h && (
            <>
              <span className="c-alt">24시간 안 주문</span>
              <span className="num" data-testid="mm-orders">
                {d.orders24h.count}건 · {won(d.orders24h.amount)}
              </span>
            </>
          )}
        </div>
        <span className="t-c1 c-alt">열람 · 클릭 집계는 실제 발송 채널이 정해지면 표시됩니다</span>
      </div>
      <div className="modal-f">
        <button className="btn btn-out" type="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}

function EditModal({ m, onClose, onDone }: { m: Msg; onClose: () => void; onDone: () => void | Promise<void> }) {
  const [title, setTitle] = useState(m.title);
  const [body, setBody] = useState(m.body);
  const [channel, setChannel] = useState<Channel>(m.channel);
  const [at, setAt] = useState(m.scheduledAt ? toLocal(m.scheduledAt) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    const r = await api(`/api/seller/member-messages/${m.id}`, { method: "PUT", body: { title, body, channel, sendMode: "SCHEDULE", scheduledAt: toIso(at) } });
    setBusy(false);
    if (!r.ok) return setErr(errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    await onDone();
  };
  return (
    <Modal labelId="mm-edit-title" busy={busy} onClose={onClose}>
      <div className="modal-h">
        <h2 className="modal-t" id="mm-edit-title">
          예약 수정
        </h2>
      </div>
      <div className="modal-b col" style={{ gap: 10 }}>
        {err && (
          <div className="msg msg-neg" role="alert">
            <span>{err}</span>
          </div>
        )}
        <label className="fld">
          <span>제목</span>
          <input className="inp" maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="fld">
          <span>채널</span>
          <select className="inp" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {CHANNELS.map((c) => (
              <option key={c.v} value={c.v}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>예약 시각 (KST)</span>
          <input className="inp" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <label className="fld">
          <span>문구</span>
          <textarea className="inp" style={{ height: 96, padding: "10px 12px" }} maxLength={500} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
      </div>
      <div className="modal-f">
        <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
          닫기
        </button>
        <button className="btn" type="button" disabled={busy || !title.trim() || !body.trim() || !at} onClick={() => void save()}>
          {busy ? "저장 중" : "저장"}
        </button>
      </div>
    </Modal>
  );
}

function NewMessage({ onDone }: { onDone: (text: string) => void | Promise<void> }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<Kind>("AD");
  const [channel, setChannel] = useState<Channel>("ALIMTALK_SMS");
  const [type, setType] = useState<TargetType>("ALL");
  const [grades, setGrades] = useState<Grade[]>([]);
  const [gradeIds, setGradeIds] = useState<string[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [term, setTerm] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [picked, setPicked] = useState<Found[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [mode, setMode] = useState<"NOW" | "SCHEDULE">("NOW");
  const [at, setAt] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<{ text: string; suggestedAt?: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ grades: Grade[] }>("/api/seller/member-grades").then((r) => r.ok && setGrades(r.data.grades));
  }, []);

  const target =
    type === "GRADE" ? { type, gradeIds } : type === "WISHED" || type === "PRODUCT_BOUGHT" ? { type, productId: product?.id ?? "" } : type === "PICKED" ? { type, memberIds: picked.map((p) => p.id) } : { type };
  const targetReady = type === "GRADE" ? gradeIds.length > 0 : type === "WISHED" || type === "PRODUCT_BOUGHT" ? !!product : type === "PICKED" ? picked.length > 0 : true;
  const payload = { title, kind, channel, body, target, sendMode: mode, ...(mode === "SCHEDULE" && at ? { scheduledAt: toIso(at) } : {}) };
  const ready = !!title.trim() && !!body.trim() && targetReady && (mode === "NOW" || !!at);

  // 대상·시각·문구가 바뀌면 미리보기를 다시 받는다(저장하지 않음)
  useEffect(() => {
    if (!body.trim() || !targetReady || (mode === "SCHEDULE" && !at)) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      const r = await api<Preview>("/api/seller/member-messages/preview", { method: "POST", body: payload });
      if (!live) return;
      if (r.ok) {
        setPreview(r.data);
        setError(null);
      } else {
        setPreview(null);
        setError({ text: errorText(r, "미리보기를 불러오지 못했습니다"), suggestedAt: (r.body?.suggestedAt as string | undefined) });
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(payload), targetReady]);

  const searchProducts = async () => {
    const r = await api<{ products: Product[] }>(`/api/seller/coupons/products?q=${encodeURIComponent(term.trim())}`);
    if (r.ok) setProducts(r.data.products);
  };
  const searchMembers = async () => {
    const r = await api<{ members: Found[] }>(`/api/seller/members?status=ACTIVE&limit=10&q=${encodeURIComponent(q.trim())}`);
    if (r.ok) setFound(r.data.members);
  };
  const submit = async () => {
    setBusy(true);
    const r = await api<{ message: Msg; rescheduled: boolean }>("/api/seller/member-messages", { method: "POST", body: payload });
    setBusy(false);
    setConfirm(false);
    if (!r.ok) return setError({ text: errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"), suggestedAt: (r.body?.suggestedAt as string | undefined) });
    await onDone(r.data.message.status === "SCHEDULED" ? (r.data.rescheduled ? `광고성 시간이 아니라 ${kstText(r.data.message.scheduledAt ?? "").slice(5, 16)}에 예약했습니다` : "예약했습니다") : `${r.data.message.recipientCount}명 발송을 기록했습니다 · 실제 발송 전`);
  };

  return (
    <section className="card mm-form" aria-label="새 발송" data-testid="mm-new">
      {error && (
        <div className="msg msg-neg" role="alert">
          <span>
            {error.text}
            {error.suggestedAt && (
              <>
                {" "}
                <button className="btn btn-sm btn-text" type="button" onClick={() => { setAt(toLocal(error.suggestedAt!)); setError(null); }}>
                  {kstText(error.suggestedAt).slice(5, 16)}으로 바꾸기
                </button>
              </>
            )}
          </span>
        </div>
      )}
      <label className="fld">
        <span className="req">제목</span>
        <input className="inp" maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="목록에서 알아보는 이름" />
      </label>
      <fieldset className="fld">
        <legend>종류</legend>
        <div className="mm-seg">
          {([["AD", "광고성"], ["INFO", "정보성 (배송 · 주문 · 약관 안내)"]] as const).map(([v, label]) => (
            <label key={v} className="row" style={{ gap: 6 }}>
              <input type="radio" name="mm-kind" checked={kind === v} onChange={() => setKind(v)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="fld">
        <legend className="req">대상</legend>
        <div className="mm-seg" role="group" aria-label="대상">
          {TARGETS.map((t) => (
            <button key={t.v} className={`btn btn-sm ${type === t.v ? "" : "btn-out"}`} type="button" aria-pressed={type === t.v} onClick={() => setType(t.v)}>
              {t.label}
            </button>
          ))}
        </div>
        {type === "GRADE" && (
          <div className="mm-seg">
            {grades.map((g) => (
              <label key={g.id} className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={gradeIds.includes(g.id)} onChange={(e) => setGradeIds((x) => (e.target.checked ? [...x, g.id] : x.filter((y) => y !== g.id)))} />
                {g.displayName}
              </label>
            ))}
          </div>
        )}
        {(type === "WISHED" || type === "PRODUCT_BOUGHT") && (
          <div className="mm-pick">
            <div className="row" style={{ gap: 8 }}>
              <input className="inp" aria-label="상품 이름 검색" placeholder="상품 이름" value={term} onChange={(e) => setTerm(e.target.value)} />
              <button className="btn btn-sm btn-out" type="button" onClick={() => void searchProducts()}>
                검색
              </button>
            </div>
            {product && <span className="t-l2">선택한 상품: <b>{product.name}</b></span>}
            {products.map((p) => (
              <button key={p.id} className="btn btn-sm btn-text" type="button" style={{ justifyContent: "flex-start" }} onClick={() => setProduct(p)}>
                {p.name}
              </button>
            ))}
          </div>
        )}
        {type === "PICKED" && (
          <div className="mm-pick">
            <div className="row" style={{ gap: 8 }}>
              <input className="inp" aria-label="회원 검색" placeholder="닉네임 · 아이디" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn btn-sm btn-out" type="button" onClick={() => void searchMembers()}>
                검색
              </button>
            </div>
            {picked.length > 0 && (
              <span className="t-l2">
                선택 {picked.length}명: {picked.map((p) => p.broadcastNickname).join(", ")}
              </span>
            )}
            {found.filter((f) => !picked.some((p) => p.id === f.id)).map((f) => (
              <button key={f.id} className="btn btn-sm btn-text" type="button" style={{ justifyContent: "flex-start" }} onClick={() => setPicked((x) => [...x, f])}>
                {f.broadcastNickname} 추가
              </button>
            ))}
          </div>
        )}
        {preview && (
          <span className="t-c1 c-alt" data-testid="mm-target-count">
            {kind === "AD" ? `혜택 · 소식 동의 회원만 자동 필터 · 대상 ${preview.consented}명 (${preview.matched}명 중 동의 ${preview.consented}명)` : `대상 ${preview.matched}명`}
          </span>
        )}
      </fieldset>
      <fieldset className="fld">
        <legend className="req">채널</legend>
        <div className="mm-seg">
          {CHANNELS.map((c) => (
            <label key={c.v} className="row" style={{ gap: 6 }}>
              <input type="radio" name="mm-channel" checked={channel === c.v} onChange={() => setChannel(c.v)} />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="fld">
        <legend className="req">보내는 시각</legend>
        <div className="mm-seg">
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" name="mm-mode" checked={mode === "NOW"} onChange={() => setMode("NOW")} />지금
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" name="mm-mode" checked={mode === "SCHEDULE"} onChange={() => setMode("SCHEDULE")} />예약
          </label>
          {mode === "SCHEDULE" && <input className="inp" style={{ width: 220 }} type="datetime-local" aria-label="예약 시각 (KST)" value={at} onChange={(e) => setAt(e.target.value)} />}
        </div>
        <span className="t-c1 c-alt">광고성은 08:00 ~ 21:00에만 · 밖이면 다음 08:00으로 자동</span>
      </fieldset>
      <label className="fld">
        <span className="req">문구</span>
        <textarea className="inp" style={{ height: 110, padding: "10px 12px" }} maxLength={500} value={body} onChange={(e) => setBody(e.target.value)} placeholder="구매자에게 보이는 문구 (해요체)" />
        <span className="help">(광고) · 쇼핑몰 이름 · 무료 수신거부는 광고성일 때 자동으로 붙습니다 · 90자를 넘으면 긴 문자</span>
      </label>
      {preview && (
        <div className="mm-pv" data-testid="mm-preview">
          <span className="t-l2 fw6">미리보기</span>
          <div className="mm-bubble">{preview.renderedBody}</div>
          <span className="t-c1 c-alt num">
            {preview.immediate ? "지금 기록" : `${kstText(preview.sendAt).slice(5, 16)} 예약`}
            {preview.rescheduled ? " (광고성 시간이 아니라 다음 08:00으로 바뀝니다)" : ""} · 최종 {preview.finalCount}명
            {preview.dailyCapped > 0 ? ` · 오늘 이미 2건을 받은 ${preview.dailyCapped}명은 제외` : ""}
            {preview.longMessage ? " · 긴 문자" : ""}
          </span>
          <span className="t-c1 c-alt">실제 발송과 충전 잔액 차감은 채널이 정해진 뒤에 연결됩니다</span>
        </div>
      )}
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" type="button" disabled={!ready || busy || !preview || preview.finalCount === 0} onClick={() => setConfirm(true)}>
          {mode === "NOW" ? "보내기 (기록)" : "예약하기"}
        </button>
      </div>
      {confirm && preview && (
        <Modal labelId="mm-confirm-title" busy={busy} onClose={() => setConfirm(false)}>
          <div className="modal-h">
            <h2 className="modal-t" id="mm-confirm-title">
              {mode === "NOW" ? "발송을 기록하시겠습니까?" : "예약하시겠습니까?"}
            </h2>
          </div>
          <div className="modal-b">
            <p className="t-l2">
              {mode === "NOW" ? (preview.rescheduled ? `${kstText(preview.sendAt).slice(5, 16)}에` : "지금") : `${kstText(preview.sendAt).slice(5, 16)}에`} {preview.finalCount}명에게 보내는 것으로 기록합니다. 실제 발송은 아직 연결되지 않았습니다.
            </p>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setConfirm(false)}>
              취소
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void submit()}>
              {busy ? "처리 중" : mode === "NOW" ? "기록" : "예약"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
