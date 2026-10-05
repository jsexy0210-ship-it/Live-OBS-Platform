"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, Modal } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { kstTime } from "../../../../../components/seller/broadcast/queue";

// SA-057 유튜브 연결(방송 › 연동). 채널 주소·방송 주소 연결/해제, 연결 상태, 연결한 방송의 채팅 수집 켜기·끄기.
// API: GET /api/seller/youtube · PUT·DELETE …/channel { url } · PUT·DELETE …/live { url } · POST …/live/find · PUT …/live/chat { enabled }
// 채팅 수집은 연결된 방송(예정·진행 중)마다 켠다(기본 꺼짐). 켜기 전에 서버가 주는 보관 고지(chatNotice)를 그대로 보여 준다.
// 시안의 「채팅 수집 기본값」·수집 현황·보관 채팅 지금 삭제는 서버 API가 없어 두지 않았다.

type Live = {
  id: string;
  url: string;
  title: string | null;
  status: "upcoming" | "live" | "ended";
  chatEnabled: boolean;
  checkedAt: string | null;
};
type Status = {
  configured: boolean;
  channel: { channelId: string; title: string; url: string; connectedAt: string } | null;
  live: Live | null;
  chatNotice: string;
};
type Load = { kind: "loading" } | { kind: "error"; status: number; error: string } | { kind: "ok"; data: Status };
type Confirm = "channel" | "live" | null;

const STATUS_TEXT: Record<Live["status"], string> = { upcoming: "예정", live: "진행 중", ended: "종료" };
// 한국 시간 월/일 시:분
const kstDate = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${kstTime(iso)}`;
};

export default function YoutubePage() {
  const { can } = useSeller();
  const allowed = can("BROADCAST_RUN");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [channelUrl, setChannelUrl] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [fieldError, setFieldError] = useState<{ channel?: string; live?: string }>({});
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  // 나중에 보낸 읽기의 응답만 반영한다
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    const r = await api<Status>("/api/seller/youtube");
    if (n !== seq.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", status: r.status, error: r.error });
  }, []);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  // 변경 공통: 결과를 서버 응답으로 확정하고(성공이든 실패든) 끝나면 다시 읽는다
  const run = async (kind: "channel" | "live" | "chat" | "find" | "unlink-channel" | "unlink-live", call: () => ReturnType<typeof api>, okText: string) => {
    setBusy(true);
    setFieldError({});
    const r = await call();
    if (r.ok) {
      setToast({ text: okText });
      if (kind === "channel") setChannelUrl("");
      if (kind === "live") setLiveUrl("");
    } else {
      const text = failMessage(r, "admin");
      if (kind === "channel") setFieldError({ channel: text });
      else if (kind === "live") setFieldError({ live: text });
      else setToast({ text, neg: true });
    }
    setConfirm(null);
    await load();
    setBusy(false);
  };

  const data = state.kind === "ok" ? state.data : null;
  const off = busy || !data?.configured;

  return (
    <>
      <Topbar crumb="방송 › 유튜브 연결" />
      <main className="main">
        <PageHead
          title="유튜브 연결"
          path={["방송", "연동", "유튜브 연결"]}
          actions={
            allowed &&
            data?.channel && (
              <button className="btn btn-out" type="button" disabled={busy} onClick={() => setConfirm("channel")}>
                연결 해제
              </button>
            )
          }
        />

        {!allowed ? (
          <div className="card">
            <NoPermission need="방송 진행" />
          </div>
        ) : state.kind === "loading" ? (
          <div className="card">
            <LoadingRows rows={4} />
          </div>
        ) : state.kind === "error" ? (
          <div className="card">
            {state.status === 402 ? (
              <Locked />
            ) : state.status === 403 && state.error === "plan_feature_required" ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <span className="t">현재 플랜에서 제공하지 않는 기능입니다</span>
              </div>
            ) : state.status === 403 ? (
              <NoPermission need="방송 진행" />
            ) : (
              <ErrorState title="유튜브 연결 상태를 불러오지 못했습니다" onRetry={() => void load()} />
            )}
          </div>
        ) : (
          <>
            {data && !data.configured && (
              <div className="msg msg-cau" role="status" data-testid="yt-not-ready">
                <b>유튜브 연결을 준비하고 있습니다.</b> 플랫폼 키가 등록되면 열립니다. 지금은 연결과 채팅 수집을 쓸 수 없습니다.
              </div>
            )}
            {data && (
              <section className="card pad col" style={{ gap: 12 }} aria-label="유튜브 연결">
                <table className="au-ft">
                  <tbody>
                    <tr>
                      <th scope="row">상태</th>
                      <td>
                        <div className="au-ft-v" data-testid="yt-status">
                          {!data.configured ? (
                            <span className="bdg">서비스 준비 중</span>
                          ) : data.channel ? (
                            <>
                              <span className="bdg b-done">연결됨</span>
                              <span className="t-c1 c-alt">
                                채널 {data.channel.title} · {kstDate(data.channel.connectedAt)} 연결
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="bdg">연결 안 됨</span>
                              <span className="t-c1 c-alt">채널 주소를 넣고 연결해 주십시오</span>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">채널 주소</th>
                      <td>
                        <div className="au-ft-v">
                          {data.channel ? (
                            <span className="t-l2">
                              <a href={data.channel.url} target="_blank" rel="noreferrer">
                                {data.channel.title}
                              </a>
                            </span>
                          ) : (
                            <form
                              className="row"
                              style={{ gap: 8, flexWrap: "wrap" }}
                              onSubmit={(e) => {
                                e.preventDefault();
                                if (channelUrl.trim() && !off) void run("channel", () => api("/api/seller/youtube/channel", { method: "PUT", body: { url: channelUrl.trim() } }), "채널을 연결했습니다");
                              }}
                            >
                              <label className="sr" htmlFor="yt-channel">
                                채널 주소
                              </label>
                              <input id="yt-channel" className="inp" style={{ width: 360, maxWidth: "100%" }} placeholder="@핸들 또는 /channel/UC… 주소" value={channelUrl} disabled={off} onChange={(e) => setChannelUrl(e.target.value)} />
                              <button className="btn" type="submit" disabled={off || !channelUrl.trim()}>
                                연결
                              </button>
                            </form>
                          )}
                          {fieldError.channel && (
                            <span className="help c-neg" role="alert" data-testid="yt-channel-error">
                              {fieldError.channel}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">방송 주소</th>
                      <td>
                        <div className="au-ft-v">
                          {data.live ? (
                            <div className="col" style={{ gap: 6, alignItems: "flex-start" }} data-testid="yt-live">
                              <span className="t-l2">
                                <a href={data.live.url} target="_blank" rel="noreferrer">
                                  {data.live.title || data.live.url}
                                </a>{" "}
                                <span className="bdg">{STATUS_TEXT[data.live.status]}</span>
                              </span>
                              <button className="btn btn-sm btn-out" type="button" disabled={off} onClick={() => setConfirm("live")}>
                                방송 연결 해제
                              </button>
                            </div>
                          ) : (
                            <div className="col" style={{ gap: 8, alignItems: "flex-start" }}>
                              <form
                                className="row"
                                style={{ gap: 8, flexWrap: "wrap" }}
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  if (liveUrl.trim() && !off) void run("live", () => api("/api/seller/youtube/live", { method: "PUT", body: { url: liveUrl.trim() } }), "방송을 연결했습니다");
                                }}
                              >
                                <label className="sr" htmlFor="yt-live-url">
                                  방송 주소
                                </label>
                                <input id="yt-live-url" className="inp" style={{ width: 360, maxWidth: "100%" }} placeholder="라이브 방송 주소 (선택)" value={liveUrl} disabled={off} onChange={(e) => setLiveUrl(e.target.value)} />
                                <button className="btn" type="submit" disabled={off || !liveUrl.trim()}>
                                  연결
                                </button>
                                <button className="btn btn-out" type="button" disabled={off || !data.channel} onClick={() => void run("find", () => api("/api/seller/youtube/live/find", { method: "POST", body: {} }), "방송을 찾아 연결했습니다")}>
                                  지금 방송 찾기
                                </button>
                              </form>
                              <span className="help">비우고 채널만 연결해도 진행 중인 공개 방송을 자동으로 찾습니다</span>
                            </div>
                          )}
                          {fieldError.live && (
                            <span className="help c-neg" role="alert" data-testid="yt-live-error">
                              {fieldError.live}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">채팅 수집</th>
                      <td>
                        <div className="au-ft-v">
                          {data.live ? (
                            <div className="col" style={{ gap: 6, alignItems: "flex-start" }}>
                              <label className="row" style={{ gap: 6 }}>
                                <input
                                  type="checkbox"
                                  data-testid="yt-chat-toggle"
                                  checked={data.live.chatEnabled}
                                  disabled={off}
                                  onChange={(e) => void run("chat", () => api("/api/seller/youtube/live/chat", { method: "PUT", body: { enabled: e.target.checked } }), e.target.checked ? "채팅 수집을 켰습니다" : "채팅 수집을 껐습니다")}
                                />
                                이 방송에서 채팅 수집 켬
                              </label>
                              <span className="help" data-testid="yt-chat-notice">
                                {data.chatNotice}
                              </span>
                            </div>
                          ) : (
                            <span className="t-c1 c-alt">연결된 방송이 있을 때 방송마다 켤 수 있습니다. 기본은 꺼짐입니다</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="msg msg-inf">공개 방송만 지원합니다. 비공개·일부 공개 방송의 채팅은 가져올 수 없습니다.</div>
              </section>
            )}
          </>
        )}
      </main>

      {confirm && (
        <Modal labelId="yt-confirm-title" busy={busy} onClose={() => setConfirm(null)}>
          <div className="modal-h">
            <h2 className="t-h2" id="yt-confirm-title">
              {confirm === "channel" ? "유튜브 연결을 해제하시겠습니까?" : "방송 연결을 해제하시겠습니까?"}
            </h2>
            <span className="t-l2 c-alt">{confirm === "channel" ? "새 방송을 자동으로 찾지 않습니다. 이미 시작된 방송은 그대로입니다." : "이 방송의 채팅 수집이 멈춥니다. 이미 시작된 방송은 그대로입니다."}</span>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setConfirm(null)}>
              닫기
            </button>
            <button
              className="btn btn-neg"
              type="button"
              disabled={busy}
              onClick={() =>
                void (confirm === "channel"
                  ? run("unlink-channel", () => api("/api/seller/youtube/channel", { method: "DELETE" }), "유튜브 연결을 해제했습니다")
                  : run("unlink-live", () => api("/api/seller/youtube/live", { method: "DELETE" }), "방송 연결을 해제했습니다"))
              }
            >
              해제
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
