"use client";

import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";

// MA-084 도우미 설정. API: GET·PUT /api/admin/assistant/settings. 바꾸기는 최고관리자만(월 한도 포함, 로그 추적).
// 모델 이름·단가는 공식 문서를 보고 직접 입력한다(코드에 고정한 값 없음). 켜려면 모델·단가가 필요하고, GEMINI_API_KEY가 서버에 없으면 켜도 「준비 중」이다.
type S = { enabled: boolean; model: string; inputWonPerMTok: number; outputWonPerMTok: number; monthlyBudgetWon: number; sellerDailyLimit: number };
type Data = { settings: S; version: number; keyConfigured: boolean; available: boolean; month: string; usedMilliWon: number; calls: Record<string, number> };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; d: Data };

export default function AssistantSettingsPage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "system.manage");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [f, setF] = useState({ model: "", inputWonPerMTok: "", outputWonPerMTok: "", monthlyBudgetWon: "", sellerDailyLimit: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await adminApi<Data>("/api/admin/assistant/settings");
    if (!r.ok) return setState({ kind: "error" });
    const s = r.data.settings;
    setF({ model: s.model, inputWonPerMTok: String(s.inputWonPerMTok || ""), outputWonPerMTok: String(s.outputWonPerMTok || ""), monthlyBudgetWon: String(s.monthlyBudgetWon), sellerDailyLimit: String(s.sellerDailyLimit) });
    setState({ kind: "ok", d: r.data });
  }, []);
  useEffect(() => void load(), [load]);

  const put = async (body: Record<string, unknown>, done: string) => {
    if (state.kind !== "ok") return;
    setBusy(true);
    setError(null);
    const r = await adminApi<Data>("/api/admin/assistant/settings", { method: "PUT", json: { ...body, expectedVersion: state.d.version } });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409) void load();
      return setError(r.message ?? "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오.");
    }
    setToast(done);
    void load();
  };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const n = (v: string) => (v.trim() === "" ? NaN : Number(v));
    void put({ model: f.model.trim(), inputWonPerMTok: n(f.inputWonPerMTok), outputWonPerMTok: n(f.outputWonPerMTok), monthlyBudgetWon: n(f.monthlyBudgetWon), sellerDailyLimit: n(f.sellerDailyLimit) }, "저장했습니다.");
  };

  const d = state.kind === "ok" ? state.d : null;
  const usedWon = d ? d.usedMilliWon / 1000 : 0;
  return (
    <>
      <AdminTopbar crumb="설정 › 도우미 설정" />
      <main className="main">
        <PageHead title="도우미 설정" />
        {!d ? (
          <div className="card">{state.kind === "loading" ? <LoadingRows rows={4} /> : <ErrorState title="도우미 설정을 불러오지 못했습니다." onRetry={() => void load()} />}</div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            <section className="card pad-l col" style={{ gap: 12 }} aria-labelledby="ast-state">
              <h2 className="t-hl1" id="ast-state">상태</h2>
              <div className="row" style={{ gap: 12 }}>
                <span className={`bdg ${d.settings.enabled ? "b-done" : "b-gray"}`} data-testid="assistant-state">{d.settings.enabled ? "켜짐" : "꺼짐"}</span>
                {canEdit && (
                  <button className="btn btn-out" type="button" disabled={busy} onClick={() => void put({ enabled: !d.settings.enabled }, d.settings.enabled ? "껐습니다." : "켰습니다.")}>
                    {d.settings.enabled ? "끄기" : "켜기"}
                  </button>
                )}
              </div>
              <dl className="kv">
                <dt>API 키</dt>
                <dd>{d.keyConfigured ? "설정됨" : "설정되지 않음 (서버 환경변수. 없으면 파트너스에게 「준비 중」으로 보입니다)"}</dd>
                <dt>파트너스 화면</dt>
                <dd>{d.available ? "사용 가능" : "준비 중"}</dd>
                <dt>{d.month} 사용</dt>
                <dd data-testid="assistant-usage">
                  {usedWon.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}원 / {d.settings.monthlyBudgetWon.toLocaleString("ko-KR")}원 (답변 {d.calls.OK ?? 0}건 · 답하지 못함 {d.calls.NO_ANSWER ?? 0}건 · 실패 {d.calls.ERROR ?? 0}건)
                </dd>
              </dl>
            </section>
            <section className="card pad-l col" style={{ gap: 12 }} aria-labelledby="ast-cfg">
              <h2 className="t-hl1" id="ast-cfg">모델·한도</h2>
              <span className="t-c1 c-alt">모델 이름과 단가는 공식 문서를 확인해 입력합니다. 단가는 100만 토큰당 원입니다. 월 한도에 닿으면 도우미 호출이 바로 멈춥니다.</span>
              <form className="col" style={{ gap: 10, maxWidth: 420 }} onSubmit={save}>
                {([["model", "모델 이름", "text"], ["inputWonPerMTok", "입력 단가(100만 토큰당 원)", "numeric"], ["outputWonPerMTok", "출력 단가(100만 토큰당 원)", "numeric"], ["monthlyBudgetWon", "월 한도(원, 플랫폼 전체)", "numeric"], ["sellerDailyLimit", "파트너스별 하루 질문 수", "numeric"]] as const).map(([k, label, mode]) => (
                  <label className="col" style={{ gap: 4 }} key={k}>
                    <span className="t-c1">{label}</span>
                    <input className="inp" inputMode={mode === "numeric" ? "numeric" : undefined} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} disabled={!canEdit || busy} />
                  </label>
                ))}
                {error && <span className="t-c1" role="alert" style={{ color: "var(--neg-text, #c00)" }}>{error}</span>}
                {canEdit ? <button className="btn btn-pri" type="submit" disabled={busy}>저장</button> : <span className="t-c1 c-alt">최고관리자만 바꿀 수 있습니다.</span>}
              </form>
            </section>
          </div>
        )}
        {toast && <Toast text={toast} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
