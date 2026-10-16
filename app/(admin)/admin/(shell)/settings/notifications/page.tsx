"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { dayTime } from "../../../_components/partners";

// MA-082 알림 채널(GET·PUT /api/admin/settings/notifications · POST …/test · POST …/reset). 정본: design/project/MA-082.dc.html(FINAL).
// 위: 운영팀 수신 채널 4종 표 + 파트너스 발신 채널(읽기 전용). 아래: 이벤트별 라우팅 표(슬랙·이메일·문자·야간 억제 체크). 보기는 모든 마스터 역할, 바꾸기·테스트 보내기·기본값 복원은 최고관리자만(system.manage).
// 서버는 저장·조회만 하고(실제 발송기는 이메일 하나뿐) 슬랙·문자·외부 모니터링은 「미연결」이다. 값이 없는 칸은 지어내지 않고 서버가 준 값만 보인다.
type Channel = "SLACK" | "EMAIL" | "SMS" | "EXTERNAL_MONITOR";
type Severity = "URGENT" | "WARNING" | "INFO";
type Link = "CONNECTED" | "NOT_CONNECTED" | "ERROR";
type ChannelRow = { channel: Channel; target: string | null; minSeverity: Severity; includeNight: boolean; status: Link; lastSentAt: string | null; lastError: string | null };
type Route = { eventKey: string; label: string; severity: Severity; slack: boolean; email: boolean; sms: boolean; roles: string[]; nightSuppress: boolean; nightSuppressible: boolean; isDefault: boolean };
type Settings = {
  channels: ChannelRow[];
  routes: Route[];
  senderProfiles: {
    alimtalk: { profile: string | null; status: Link };
    sms: { senderNumber: string | null; status: Link };
    email: { address: string | null; status: Link };
    usage: { month: string; alimtalk: number; sms: number; email: number };
  };
  updatedAt: string | null;
};
type TestResult = { channel: Channel; status: "SENT" | "NOT_CONNECTED" | "FAILED" };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Settings };
type Draft = Record<string, { slack: boolean; email: boolean; sms: boolean; nightSuppress: boolean }>;

const CHANNEL_NAME: Record<Channel, string> = { SLACK: "슬랙", EMAIL: "이메일", SMS: "문자", EXTERNAL_MONITOR: "외부 모니터링" };
const LINK: Record<Link, { label: string; cls: string }> = { CONNECTED: { label: "연결됨", cls: "b-done" }, NOT_CONNECTED: { label: "미연결", cls: "b-gray" }, ERROR: { label: "오류", cls: "b-fail" } };
const SEVERITY: Record<Severity, { label: string; cls: string }> = { URGENT: { label: "긴급", cls: "b-fail" }, WARNING: { label: "주의", cls: "b-warn" }, INFO: { label: "정보", cls: "b-info" } };
const SEVERITY_TEXT: Record<Severity, string> = { URGENT: "긴급 등급만", WARNING: "긴급 · 주의 등급만", INFO: "모든 등급" };
const ROLE: Record<string, string> = { SUPER_ADMIN: "최고관리자", OPERATIONS: "운영", CS: "CS", READ_ONLY: "조회 전용" };

const toDraft = (routes: Route[]): Draft => Object.fromEntries(routes.map((r) => [r.eventKey, { slack: r.slack, email: r.email, sms: r.sms, nightSuppress: r.nightSuppress }]));
const num = (n: number) => n.toLocaleString("ko-KR");
// 채널 줄의 「설정」 칸: 마지막 발송이 있으면 그 시각, 없으면 받을 등급(+야간). 연결 전이고 주소도 없으면 안내.
function setting(c: ChannelRow): string {
  if (c.lastSentAt) return `마지막 발송 ${dayTime(c.lastSentAt).slice(-5)}`;
  if (c.status === "NOT_CONNECTED" && !c.target) return "아직 연결 안 됐습니다 · 주소를 넣으면 연결됩니다";
  return `${SEVERITY_TEXT[c.minSeverity]}${c.includeNight ? " · 야간(22~08시) 포함" : ""}`;
}

export default function NotificationChannelsPage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "system.manage");
  const { confirm } = useConfirm();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft>({});
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const reqId = useRef(0);
  const apply = (data: Settings) => {
    setState({ kind: "ok", data });
    setDraft(toDraft(data.routes));
  };
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Settings>("/api/admin/settings/notifications");
    if (id !== reqId.current) return;
    if (r.ok) {
      setState({ kind: "ok", data: r.data });
      setDraft(toDraft(r.data.routes));
    } else setState({ kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const data = state.kind === "ok" ? state.data : null;
  const changed = (data?.routes ?? []).filter((r) => {
    const d = draft[r.eventKey];
    return d && (d.slack !== r.slack || d.email !== r.email || d.sms !== r.sms || d.nightSuppress !== r.nightSuppress);
  });
  const set = (key: string, patch: Partial<Draft[string]>) => setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  const save = async () => {
    if (!data || changed.length === 0) return;
    const routes = changed.map((r) => ({ eventKey: r.eventKey, ...draft[r.eventKey], roles: r.roles }));
    const ok = await confirm({
      title: `알림 라우팅 ${changed.length}개를 변경하시겠습니까?`,
      body: changed.map((r) => r.label).join(" · "),
      confirmLabel: "저장",
      run: async () => {
        const r = await adminApi<{ settings: Settings }>("/api/admin/settings/notifications", { method: "PUT", json: { routes } });
        if (!r.ok) return r.message ?? failMessage(r, "알림 라우팅을 저장하지 못했습니다. 입력한 값을 확인해 주십시오.");
        apply(r.data.settings);
        return undefined;
      },
    });
    if (ok) setToast({ text: "알림 라우팅을 저장했습니다" });
  };
  const cancel = () => data && setDraft(toDraft(data.routes));
  const reset = async () => {
    const ok = await confirm({
      title: "알림 라우팅을 기본값으로 되돌리시겠습니까?",
      body: "바꾼 이벤트별 라우팅이 모두 지워집니다 · 채널 설정은 그대로입니다.",
      confirmLabel: "기본값 복원",
      run: async () => {
        const r = await adminApi<{ settings: Settings }>("/api/admin/settings/notifications/reset", { method: "POST" });
        if (!r.ok) return r.message ?? failMessage(r, "기본값으로 되돌리지 못했습니다. 잠시 후 다시 시도해 주십시오.");
        apply(r.data.settings);
        return undefined;
      },
    });
    if (ok) setToast({ text: "알림 라우팅을 기본값으로 되돌렸습니다" });
  };
  const test = async () => {
    let results: TestResult[] = [];
    const ok = await confirm({
      title: "테스트 알림을 보내시겠습니까?",
      body: "연결된 채널로만 테스트를 보냅니다 · 연결 안 된 채널은 건너뜁니다.",
      confirmLabel: "테스트 보내기",
      run: async () => {
        const r = await adminApi<{ results: TestResult[]; settings: Settings }>("/api/admin/settings/notifications/test", { method: "POST", json: {} });
        if (!r.ok) return r.message ?? failMessage(r, "테스트를 보내지 못했습니다. 잠시 후 다시 시도해 주십시오.");
        results = r.data.results;
        setState((s) => (s.kind === "ok" ? { kind: "ok", data: { ...r.data.settings } } : s));
        return undefined;
      },
    });
    if (!ok) return;
    const names = (st: TestResult["status"]) => results.filter((x) => x.status === st).map((x) => CHANNEL_NAME[x.channel]);
    const sent = names("SENT");
    const failed = names("FAILED");
    const skipped = names("NOT_CONNECTED");
    const text = [sent.length > 0 ? `${sent.join(" · ")}로 테스트를 보냈습니다` : "테스트를 보낸 채널이 없습니다", failed.length > 0 ? `보내지 못함: ${failed.join(" · ")}` : "", skipped.length > 0 ? `미연결: ${skipped.join(" · ")}` : ""].filter(Boolean).join(" · ");
    setToast({ text, neg: sent.length === 0 || failed.length > 0 });
  };

  const sp = data?.senderProfiles;
  const badge = (s: Link, word: string) => <span className={`bdg ${s === "CONNECTED" ? "b-done" : "b-gray"}`}>{s === "CONNECTED" ? word : "미연결"}</span>;

  return (
    <>
      <AdminTopbar crumb="설정 › 알림 채널" />
      <main className="main">
        <PageHead title="알림 채널" />
        {state.kind === "loading" && <LoadingRows rows={5} />}
        {state.kind === "error" && <ErrorState title="불러오지 못했습니다." onRetry={() => void load()} />}
        {data && sp && (
          <div className="col" style={{ gap: 24 }}>
            {!canEdit && (
              <div className="msg msg-info" role="note">
                조회 전용 권한입니다 · 변경 버튼은 보이지 않습니다 · 필요한 권한: 시스템 설정
              </div>
            )}
            {data.channels.filter((c) => c.status === "ERROR").map((c) => (
              <div key={c.channel} className="msg msg-neg" role="alert">
                <b>{CHANNEL_NAME[c.channel]} 연결이 끊겼습니다.</b> {c.lastError ?? ""}
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 24, alignItems: "start" }}>
              <section className="col" style={{ gap: 12 }} aria-labelledby="notify-ops">
                <h2 className="t-hl1" id="notify-ops">
                  운영팀 수신 채널 (내부 알림)
                </h2>
                <table className="tbl" data-testid="notify-channels">
                  <thead>
                    <tr>
                      <th>채널</th>
                      <th>설정</th>
                      <th>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.channels.map((c) => (
                      <tr key={c.channel}>
                        <td>
                          <b>{c.target ? `${CHANNEL_NAME[c.channel]} · ${c.target}` : CHANNEL_NAME[c.channel]}</b>
                        </td>
                        <td>{setting(c)}</td>
                        <td>
                          <span className={`bdg ${LINK[c.status].cls}`}>{LINK[c.status].label}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="col" style={{ gap: 12 }}>
                <FormSection title="파트너스 발신 채널 (플랫폼 → 파트너스)">
                  <FormRow label="알림톡 발신 프로필">
                    {sp.alimtalk.profile ?? "-"} {badge(sp.alimtalk.status, "승인")}
                  </FormRow>
                  <FormRow label="문자 발신번호">
                    {sp.sms.senderNumber ?? "-"} {badge(sp.sms.status, "인증")}
                  </FormRow>
                  <FormRow label="이메일 발신">
                    {sp.email.address ?? "-"} {badge(sp.email.status, "연결됨")}
                  </FormRow>
                  <FormRow label="이번 달 사용">{`알림톡 ${num(sp.usage.alimtalk)} · 문자 ${num(sp.usage.sms)} · 이메일 ${num(sp.usage.email)}`}</FormRow>
                </FormSection>
                <span className="t-c1 c-alt">파트너스가 구매자에게 보내는 알림은 파트너스 발신 프로필로 따로 보냅니다</span>
              </section>
            </div>

            <section className="col" style={{ gap: 12 }} aria-labelledby="notify-routing">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
                  <h2 className="t-hl1" id="notify-routing">
                    이벤트별 라우팅
                  </h2>
                  <span className="t-c1 c-alt">등급 · 채널 · 수신자 역할 · 야간 억제</span>
                </div>
                {canEdit && (
                  <button className="btn btn-sm btn-out" type="button" onClick={() => void reset()}>
                    기본값 복원
                  </button>
                )}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" data-testid="notify-routes">
                  <thead>
                    <tr>
                      <th>이벤트</th>
                      <th>등급</th>
                      <th>슬랙</th>
                      <th>이메일</th>
                      <th>문자</th>
                      <th>수신 역할</th>
                      <th>야간 억제</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.routes.map((r) => {
                      const d = draft[r.eventKey] ?? r;
                      const box = (key: "slack" | "email" | "sms" | "nightSuppress", label: string) => (
                        <input className="chkbox" type="checkbox" aria-label={`${r.label} · ${label}`} checked={d[key]} disabled={!canEdit} onChange={(e) => set(r.eventKey, { [key]: e.target.checked })} />
                      );
                      return (
                        <tr key={r.eventKey} data-testid="notify-route">
                          <td>
                            <b>{r.label}</b>
                          </td>
                          <td>
                            <span className={`bdg ${SEVERITY[r.severity].cls}`}>{SEVERITY[r.severity].label}</span>
                          </td>
                          <td>{box("slack", "슬랙")}</td>
                          <td>{box("email", "이메일")}</td>
                          <td>{box("sms", "문자")}</td>
                          <td>{r.roles.length === 0 ? "전체" : r.roles.map((x) => ROLE[x] ?? x).join(" · ")}</td>
                          <td>{r.nightSuppressible ? box("nightSuppress", "야간 억제") : <span className="c-alt">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <span className="t-c1 c-alt">긴급 등급은 야간 억제를 켤 수 없습니다</span>
            </section>

            {canEdit && (
              <div className="row" style={{ gap: 8, justifyContent: "center" }}>
                <button className="btn btn-lg" type="button" onClick={() => void save()} disabled={changed.length === 0}>
                  저장
                </button>
                <button className="btn btn-lg btn-out" type="button" onClick={cancel} disabled={changed.length === 0}>
                  취소
                </button>
                <button className="btn btn-lg btn-out" type="button" onClick={() => void test()}>
                  테스트 보내기
                </button>
              </div>
            )}
          </div>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
