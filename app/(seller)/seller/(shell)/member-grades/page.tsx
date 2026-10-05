"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { StateBox, errorText, kstText, stateKind } from "../banners/_shared/ui";
import "./member-grades.css";

// SA-044 회원 등급(파트너스 관리자, 회원 › 회원 등급). 등급 이름 · 승급 기준 금액, 매월 1일 자동 재산정, 회원 직접 조정(고정), 최근 변경.
// 조회와 변경은 대표자 · 회원/적립금(MEMBER_POINTS) 권한 직원. 적립률은 적립 정책에서 정하고 여기서는 보기만 한다. API: /api/seller/member-grades.
type Grade = { id: string; displayName: string; sortOrder: number; minAmount: number; isBase: boolean; custom: boolean; members: number; rewardCard: number | null; rewardBankTransfer: number | null };
type Data = {
  grades: Grade[];
  autoEnabled: boolean;
  lockedCount: number;
  lastRun: { monthKey: string; promoted: number; demoted: number; ranAt: string } | null;
  nextRunAt: string;
  recent: { id: string; nickname: string; fromName: string; toName: string; reason: "AUTO_UP" | "AUTO_DOWN" | "MANUAL"; amount: number | null; createdAt: string }[];
  locked: { memberId: string; nickname: string; gradeId: string }[];
};
type Found = { id: string; broadcastNickname: string; grade: { id: string; displayName: string } };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const REASON = { AUTO_UP: "자동 승급", AUTO_DOWN: "자동 강등", MANUAL: "직접 조정" } as const;
const digits = (v: string) => v.replace(/[^0-9]/g, "");

export default function MemberGradesPage() {
  const { can } = useSeller();
  const canEdit = can("MEMBER_POINTS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [edit, setEdit] = useState<{ id: string; displayName: string; minAmount: string }[]>([]);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");

  const load = useCallback(async () => {
    const r = await api<Data>("/api/seller/member-grades");
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", data: r.data });
    setEdit(r.data.grades.map((g) => ({ id: g.id, displayName: g.displayName, minAmount: String(g.minAmount) })));
    setAuto(r.data.autoEnabled);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const data = state.kind === "ok" ? state.data : null;
  const run = async (path: string, method: string, body: unknown, done: string) => {
    setBusy(true);
    setFailure(null);
    const r = await api(path, { method, body });
    setBusy(false);
    if (!r.ok) {
      setFailure(errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
      return false;
    }
    setToast(done);
    await load();
    return true;
  };

  const save = () => void run("/api/seller/member-grades", "PUT", { autoEnabled: auto, grades: edit.map((e) => ({ id: e.id, displayName: e.displayName, minAmount: Number(e.minAmount || 0) })) }, "등급 설정을 저장했습니다");
  const add = async () => {
    if (await run("/api/seller/member-grades", "POST", { displayName: newName, minAmount: Number(newAmount || 0) }, "등급을 추가했습니다")) {
      setNewName("");
      setNewAmount("");
    }
  };

  return (
    <>
      <Topbar crumb="회원 › 회원 등급" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">회원 등급</h1>
            <span className="t-l2 c-alt">등급 이름 · 승급 기준 금액 · 매월 자동 재산정 · 회원 직접 조정</span>
          </div>
          {data && canEdit && (
            <button className="btn" type="button" disabled={busy} onClick={save}>
              {busy ? "저장 중" : "저장"}
            </button>
          )}
        </div>
        {state.kind === "loading" && <StateBox kind="loading" what="회원 등급" />}
        {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="회원 등급" onRetry={() => void load()} />}
        {data && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>보기만 할 수 있습니다. 등급 변경은 대표자나 회원 · 적립금 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        {failure && (
          <div className="msg msg-neg" role="alert">
            <span>
              <b>저장할 수 없습니다.</b> {failure}
            </span>
          </div>
        )}
        {data && (
          <>
            <section className="card pad col" style={{ gap: 10 }} aria-label="자동 재산정">
              <div className="row between">
                <span className="col" style={{ gap: 2 }}>
                  <span className="t-hl2" id="mg-auto-label">
                    자동 재산정
                  </span>
                  <span className="t-c1 c-alt">매월 1일 0시에 최근 6개월 결제 금액으로 등급을 다시 정합니다 · 승급은 바로, 강등은 한 단계씩 · 고정한 회원은 제외</span>
                </span>
                <button className={`sw${auto ? " on" : ""}`} type="button" role="switch" aria-checked={auto} aria-labelledby="mg-auto-label" disabled={!canEdit} onClick={() => setAuto(!auto)} />
              </div>
              <span className="t-c1 c-alt num">
                다음 재산정 {kstText(data.nextRunAt)}
                {data.lastRun ? ` · 지난 재산정 ${data.lastRun.monthKey} (승급 ${data.lastRun.promoted}명 · 강등 ${data.lastRun.demoted}명)` : " · 지난 재산정 없음"}
              </span>
            </section>

            <section className="card" style={{ overflow: "hidden" }} aria-label="등급 목록">
              <div className="mg-grid mg-head">
                <span>등급 이름</span>
                <span>기준 금액 (최근 6개월)</span>
                <span className="mg-hide-m">회원 수</span>
                <span className="mg-hide-m">적립률 (카드 · 무통장)</span>
                <span className="mg-hide-m" />
              </div>
              {data.grades.map((g, i) => (
                <div key={g.id} className="mg-grid" data-testid="grade-row">
                  <input className="inp" aria-label={`${i + 1}번째 등급 이름`} maxLength={12} disabled={!canEdit} value={edit[i]?.displayName ?? ""} onChange={(e) => setEdit((x) => x.map((y, j) => (j === i ? { ...y, displayName: e.target.value } : y)))} />
                  <input
                    className="inp num"
                    inputMode="numeric"
                    aria-label={`${edit[i]?.displayName ?? ""} 기준 금액`}
                    disabled={!canEdit || g.isBase}
                    value={g.isBase ? "0" : (edit[i]?.minAmount ?? "")}
                    onChange={(e) => setEdit((x) => x.map((y, j) => (j === i ? { ...y, minAmount: digits(e.target.value) } : y)))}
                  />
                  <span className="mg-hide-m num">{g.members.toLocaleString("ko-KR")}명</span>
                  <span className="mg-hide-m t-c1 c-alt num">{g.rewardCard === null && g.rewardBankTransfer === null ? "적립 정책에서 설정" : `${g.rewardCard ?? 0}% · ${g.rewardBankTransfer ?? 0}%`}</span>
                  <span className="mg-hide-m">
                    {canEdit && g.custom && g.members === 0 && (
                      <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} disabled={busy} onClick={() => void run(`/api/seller/member-grades/${g.id}`, "DELETE", undefined, "등급을 지웠습니다")}>
                        삭제
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {canEdit && (
                <div className="mg-grid">
                  <input className="inp" aria-label="새 등급 이름" placeholder="새 등급 이름" maxLength={12} value={newName} onChange={(e) => setNewName(e.target.value)} />
                  <input className="inp num" inputMode="numeric" aria-label="새 등급 기준 금액" placeholder="기준 금액" value={newAmount} onChange={(e) => setNewAmount(digits(e.target.value))} />
                  <span className="mg-hide-m" />
                  <span className="mg-hide-m" />
                  <button className="btn btn-sm btn-out" type="button" disabled={busy || !newName.trim()} onClick={() => void add()}>
                    추가
                  </button>
                </div>
              )}
            </section>
            <span className="t-c1 c-alt">기준 금액은 등급이 높을수록 커야 합니다 · 첫 등급은 0원 · 등급은 10개까지 · 기본 등급은 지울 수 없고, 직접 만든 등급은 회원이 없을 때만 지울 수 있음</span>

            {canEdit && <MemberAdjust grades={data.grades} onDone={(t) => { setToast(t); void load(); }} />}

            <section className="card" aria-label="고정한 회원">
              <div className="row between" style={{ padding: "12px 16px" }}>
                <span className="t-hl2">고정한 회원 {data.lockedCount}명</span>
                <span className="t-c1 c-alt">자동 재산정에서 제외</span>
              </div>
              {data.locked.length === 0 ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <span className="t">고정한 회원이 없습니다</span>
                </div>
              ) : (
                data.locked.map((l) => (
                  <div key={l.memberId} className="mg-log">
                    <span>{l.nickname}</span>
                    <span className="c-alt">{data.grades.find((g) => g.id === l.gradeId)?.displayName}</span>
                  </div>
                ))
              )}
            </section>

            <section className="card" aria-label="최근 변경">
              <div style={{ padding: "12px 16px" }}>
                <span className="t-hl2">최근 변경</span>
              </div>
              {data.recent.length === 0 ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <span className="t">등급 변경 기록이 없습니다</span>
                </div>
              ) : (
                data.recent.map((h) => (
                  <div key={h.id} className="mg-log" data-testid="grade-log">
                    <span className="col" style={{ gap: 2 }}>
                      <span>
                        {h.nickname} · {h.fromName} → {h.toName}
                      </span>
                      <span className="t-c1 c-alt">
                        {REASON[h.reason]}
                        {h.amount !== null ? ` · 최근 6개월 ${won(h.amount)}` : ""}
                      </span>
                    </span>
                    <span className="t-c1 c-alt num">{kstText(h.createdAt)}</span>
                  </div>
                ))
              )}
            </section>
          </>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

// 회원 직접 조정: 닉네임으로 찾아 등급을 고르고, 고정하면 자동 재산정에서 제외
function MemberAdjust({ grades, onDone }: { grades: Grade[]; onDone: (text: string) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [pick, setPick] = useState<Record<string, { gradeId: string; lock: boolean }>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setErr(null);
    const r = await api<{ members: Found[] }>(`/api/seller/members?status=ACTIVE&limit=10&q=${encodeURIComponent(q.trim())}`);
    if (!r.ok) return setErr(errorText(r, "회원을 찾지 못했습니다"));
    setFound(r.data.members);
    setPick(Object.fromEntries(r.data.members.map((m) => [m.id, { gradeId: m.grade.id, lock: false }])));
  };
  const apply = async (m: Found) => {
    setBusy(true);
    setErr(null);
    const p = pick[m.id];
    const r = await api(`/api/seller/member-grades/members/${m.id}`, { method: "PUT", body: p });
    setBusy(false);
    if (!r.ok) return setErr(errorText(r, "조정하지 못했습니다"));
    onDone(`${m.broadcastNickname} 등급을 조정했습니다${p.lock ? " · 자동 재산정에서 제외" : ""}`);
    await search();
  };

  return (
    <section className="card" aria-label="회원 등급 조정">
      <div className="row between" style={{ padding: "12px 16px", gap: 8, flexWrap: "wrap" }}>
        <span className="t-hl2">회원 등급 조정</span>
        <form
          className="row"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input className="inp inp-sm" aria-label="회원 닉네임 검색" placeholder="방송 닉네임" maxLength={30} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-sm btn-out" type="submit">
            검색
          </button>
        </form>
      </div>
      {err && (
        <div className="msg msg-neg" role="alert">
          <span>{err}</span>
        </div>
      )}
      {found !== null && found.length === 0 && (
        <div className="st" style={{ boxShadow: "none" }}>
          <span className="t">찾는 회원이 없습니다</span>
        </div>
      )}
      {found?.map((m) => (
        <div key={m.id} className="mg-adj" data-testid="adjust-row">
          <span>{m.broadcastNickname}</span>
          <select className="inp inp-sm" aria-label={`${m.broadcastNickname} 등급`} value={pick[m.id]?.gradeId} onChange={(e) => setPick((x) => ({ ...x, [m.id]: { ...x[m.id], gradeId: e.target.value } }))}>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.displayName}
              </option>
            ))}
          </select>
          <label className="row t-l2" style={{ gap: 6 }}>
            <input className="cbx" type="checkbox" checked={pick[m.id]?.lock ?? false} onChange={(e) => setPick((x) => ({ ...x, [m.id]: { ...x[m.id], lock: e.target.checked } }))} />
            고정
          </label>
          <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void apply(m)}>
            적용
          </button>
        </div>
      ))}
    </section>
  );
}
