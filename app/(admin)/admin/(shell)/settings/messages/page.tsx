"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { CHANNEL_LABEL, UNIT_PRICE_MAX, won, type ChannelPrice, type MessageSettings } from "../../../_components/messageFees";
import { dayTime } from "../../../_components/partners";
import { ValueDialog } from "../../../_components/ValueDialog";

// MA-086 발송 단가(GET·PUT /api/admin/message-settings, POST /api/admin/message-prices/{channel}). 설정은 최고관리자만 열린다.
// 충전 스위치는 파트너스의 선불 충전·차감을 켜고 끄는 큰 스위치라 바꿀 때 확인 창을 거친다(켜기는 서버가 정기 작업이 도는지도 확인한다).
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: MessageSettings };

export default function MessagePricesPage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "billing.price");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [priceDialog, setPriceDialog] = useState<ChannelPrice | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [limits, setLimits] = useState({ day: "", month: "" });
  const [busy, setBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);

  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const r = await adminApi<MessageSettings>("/api/admin/message-settings");
    if (id !== reqId.current) return;
    if (r.ok) {
      setLimits({ day: String(r.data.platformDailyLimit), month: String(r.data.platformMonthlyLimit) });
      setState({ kind: "ok", data: r.data });
    } else setState({ kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const d = state.kind === "ok" ? state.data : null;

  const putSettings = async (body: Record<string, unknown>) => {
    setBusy(true);
    const r = await adminApi<MessageSettings>("/api/admin/message-settings", { method: "PUT", json: body });
    setBusy(false);
    return r;
  };
  const toggleCharging = async () => {
    if (!d) return;
    setSwitchError(null);
    const r = await putSettings({ chargingEnabled: !d.chargingEnabled });
    if (r.ok) {
      setConfirmSwitch(false);
      setToast({ text: r.data.chargingEnabled ? "충전을 켰습니다." : "충전을 껐습니다." });
      void load();
    } else setSwitchError(r.message ?? (r.status === 403 ? "최고관리자만 바꿀 수 있습니다." : "바꾸지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  const saveLimits = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!d) return;
    setLimitError(null);
    const day = Number(limits.day);
    const month = Number(limits.month);
    if (!Number.isInteger(day) || !Number.isInteger(month) || day < 0 || month < 0 || limits.day.trim() === "" || limits.month.trim() === "") return setLimitError("한도는 0 이상의 정수로 입력해 주십시오.");
    const r = await putSettings({ platformDailyLimit: day, platformMonthlyLimit: month });
    if (r.ok) {
      setToast({ text: "저장했습니다." });
      void load();
    } else setLimitError(r.message ?? "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오.");
  };

  return (
    <>
      <AdminTopbar crumb="설정 › 발송 단가" />
      <main className="main">
        <PageHead title="발송 단가" />
        {!d ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" && <ErrorState title="발송 설정을 불러오지 못했습니다." onRetry={() => void load()} />}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="msg-charging">
              <h2 className="t-hl1" id="msg-charging">
                충전
              </h2>
              <div className="row" style={{ gap: 12 }}>
                <span className={`bdg ${d.chargingEnabled ? "b-done" : "b-gray"}`} data-testid="charging-state">
                  {d.chargingEnabled ? "켜짐" : "꺼짐"}
                </span>
                {canEdit && (
                  <button className="btn btn-out" type="button" onClick={() => { setSwitchError(null); setConfirmSwitch(true); }}>
                    {d.chargingEnabled ? "충전 끄기" : "충전 켜기"}
                  </button>
                )}
              </div>
              <span className="t-c1 c-alt">켜면 파트너스의 발송 비용이 선불 잔액에서 차감됩니다. 꺼 두면 차감하지 않습니다.</span>
            </section>

            <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="msg-prices">
              <h2 className="t-hl1" id="msg-prices">
                채널별 단가
              </h2>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                  <thead>
                    <tr>
                      <th>채널</th>
                      <th>현재 단가</th>
                      <th>변경 후 단가</th>
                      <th>적용 예정일</th>
                      {canEdit && <th>작업</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {d.prices.map((p) => (
                      <tr key={p.channel} data-testid="price-row">
                        <td className="fw6">{CHANNEL_LABEL[p.channel]}</td>
                        <td className="num">{won(p.unitPrice)}</td>
                        <td className="num">{p.next ? won(p.next.unitPrice) : "-"}</td>
                        <td className="num">{p.next ? dayTime(p.next.effectiveAt) : "-"}</td>
                        {canEdit && (
                          <td>
                            <button className="btn btn-sm btn-out" type="button" onClick={() => setPriceDialog(p)}>
                              변경
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="msg-limits">
              <h2 className="t-hl1" id="msg-limits">
                플랫폼 메일 무료 한도
              </h2>
              <dl className="kv">
                <dt>오늘 사용</dt>
                <dd data-testid="usage-today">
                  {d.usage.today.used.toLocaleString("ko-KR")}통 / {d.usage.today.limit.toLocaleString("ko-KR")}통
                </dd>
                <dt>이번 달 사용</dt>
                <dd data-testid="usage-month">
                  {d.usage.thisMonth.used.toLocaleString("ko-KR")}통 / {d.usage.thisMonth.limit.toLocaleString("ko-KR")}통
                </dd>
                <dt>한도 초과로 못 보낸 메일</dt>
                <dd>{d.usage.skippedPlatformLimit.toLocaleString("ko-KR")}통</dd>
              </dl>
              {canEdit && (
                <form className="col" style={{ gap: 12 }} onSubmit={saveLimits} noValidate>
                  <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                    <div className="fld">
                      <label htmlFor="limit-day">하루 한도</label>
                      <input id="limit-day" className="inp" type="text" inputMode="numeric" value={limits.day} onChange={(e) => setLimits({ ...limits, day: e.target.value })} disabled={busy} />
                    </div>
                    <div className="fld">
                      <label htmlFor="limit-month">월 한도</label>
                      <input id="limit-month" className="inp" type="text" inputMode="numeric" value={limits.month} onChange={(e) => setLimits({ ...limits, month: e.target.value })} disabled={busy} />
                    </div>
                  </div>
                  {limitError && (
                    <span className="err" role="alert">
                      {limitError}
                    </span>
                  )}
                  <div>
                    <button className="btn" type="submit" disabled={busy}>
                      한도 저장
                    </button>
                  </div>
                </form>
              )}
            </section>
          </div>
        )}
      </main>

      {priceDialog && (
        <ValueDialog
          title={`${CHANNEL_LABEL[priceDialog.channel]} 단가 변경`}
          label="단가"
          unit="원"
          current={priceDialog.unitPrice}
          max={UNIT_PRICE_MAX}
          path={`/api/admin/message-prices/${priceDialog.channel}`}
          field="unitPrice"
          onClose={() => setPriceDialog(null)}
          onDone={() => {
            setPriceDialog(null);
            setToast({ text: "단가를 저장했습니다." });
            void load();
          }}
        />
      )}
      {confirmSwitch && d && (
        <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="charging-title">
          <div className="modal">
            <div className="modal-h">
              <h2 className="t-h2" id="charging-title">
                {d.chargingEnabled ? "충전을 끄시겠습니까?" : "충전을 켜시겠습니까?"}
              </h2>
              <span className="t-l2 c-alt">
                {d.chargingEnabled ? "꺼지면 파트너스의 발송 비용을 잔액에서 차감하지 않습니다." : "켜지면 지금부터 파트너스의 발송 비용이 선불 잔액에서 차감됩니다."}
              </span>
            </div>
            {switchError && (
              <div style={{ padding: "0 24px" }}>
                <span className="err" role="alert">
                  {switchError}
                </span>
              </div>
            )}
            <div className="modal-f">
              <button className="btn btn-out" type="button" onClick={() => setConfirmSwitch(false)} disabled={busy}>
                취소
              </button>
              <button className="btn" type="button" onClick={() => void toggleCharging()} disabled={busy}>
                {busy ? "처리 중" : d.chargingEnabled ? "충전 끄기" : "충전 켜기"}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
