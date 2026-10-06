"use client";

import "../../../../../../styles/seller-overlay.css";
import { useCallback, useEffect, useState } from "react";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { PageHead } from "../../../../../../components/admin-ui";
import Link from "next/link";
import { ago, formatDate, formatDateTime } from "../../../../../../lib/client/format";

// SA-052 방송 프로그램에 넣기(방송 화면 꾸미기의 둘째 탭): 방송 화면 주소 발급·재발급과 OBS에 넣는 방법.
// 주소의 토큰은 서버에 해시로만 남아 지금 쓰는 주소를 다시 보여 줄 수 없다: 발급할 때 이 화면에서 한 번만 보이고,
// 다시 발급하면 이전 주소는 바로 끊긴다(OBS에 넣은 주소도 바꿔야 한다).
// 결과가 불분명하면(연결 끊김·서버 오류) 발급됐는지 알 수 없으므로 성공으로 보이지 않고, 이전 주소가 끊겼을 수 있다고 알린다.
// API: POST /api/seller/overlay/token(OVERLAY_EDIT, 방송 중 재발급은 409 live) · GET /api/seller/overlay/address-info(발급일·마지막 접속·접속 기록·재발급 이력)

type Issued = { token: string; at: number };
type Info = {
  issuedAt: string | null;
  lastAccessAt: string | null;
  lastClient: string | null;
  connected: boolean;
  openSources: number;
  live: boolean;
  accesses: { at: string; client: string; layout: "9x16" | "16x9" | null; state: "connected" | "ended" | "unknown_browser" }[];
  reissues: { at: string; by: string | null; kind: "first" | "reissue" }[];
};
const LAYOUT = { "9x16": "세로형", "16x9": "가로형" } as const;
const ACCESS_STATE = { connected: "연결 중", ended: "종료", unknown_browser: "미확인 브라우저" } as const;
type Fail = { kind: "unclear" } | { kind: "locked" } | { kind: "plan" } | { kind: "forbidden" } | { kind: "other"; text: string };

const urls = (token: string) => {
  const base = `${window.location.origin}/overlay/${token}`;
  return [
    { key: "port", label: "세로 9:16", size: "너비 1080 · 높이 1920", url: base },
    { key: "land", label: "가로 16:9", size: "너비 1920 · 높이 1080", url: `${base}?ratio=16x9` },
  ];
};

export default function OverlayPage() {
  const { can } = useSeller();
  const allowed = can("OVERLAY_EDIT");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Fail | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const loadInfo = useCallback(async () => {
    const r = await api<Info>("/api/seller/overlay/address-info");
    if (r.ok) setInfo(r.data);
  }, []);
  useEffect(() => {
    if (allowed) void loadInfo();
  }, [allowed, loadInfo]);

  const issue = async () => {
    setBusy(true);
    setFail(null);
    const r = await api<{ token: string }>("/api/seller/overlay/token", { method: "POST", body: {} });
    setBusy(false);
    setConfirm(false);
    if (r.ok) {
      void loadInfo();
      setIssued({ token: r.data.token, at: Date.now() });
      return setToast({ text: "새 주소를 만들었습니다" });
    }
    // 불분명: 서버가 이미 새 주소를 만들고 이전 주소를 끊었을 수 있어 보이던 주소도 지운다(끊긴 주소를 OBS에 넣지 않게)
    if (r.status === 0 || r.status >= 500) {
      setIssued(null);
      return setFail({ kind: "unclear" });
    }
    if (r.status === 409 && r.error === "live") {
      void loadInfo();
      return setFail({ kind: "other", text: "방송 중에는 주소를 다시 만들 수 없습니다. 방송을 끝낸 뒤 진행해 주십시오." });
    }
    if (r.status === 402) return setFail({ kind: "locked" });
    if (r.status === 403) return setFail({ kind: r.error === "plan_feature_required" ? "plan" : "forbidden" });
    setFail({ kind: "other", text: failMessage(r, "admin") });
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setToast({ text: "주소를 복사했습니다" });
      // 시작하기(SA-003) 「오버레이 주소 복사」 단계를 완료로 남긴다(권한이 없거나 실패해도 복사 결과에는 영향 없음)
      void api("/api/seller/onboarding", { method: "POST", body: { action: "overlay_url_copied" } });
    } catch {
      setToast({ text: "복사하지 못했습니다. 주소를 직접 선택해 복사해 주십시오", neg: true });
    }
  };

  return (
    <>
      <Topbar crumb="방송 › 방송 화면 꾸미기 › 방송 프로그램에 넣기" />
      <main className="main">
        <PageHead
          title="방송 프로그램에 넣기"
          actions={
            <Link className="btn btn-out" href="/seller/overlay">
              방송 화면 꾸미기
            </Link>
          }
        />

        {!allowed ? (
          <div className="card">
            <NoPermission need="오버레이 편집" />
          </div>
        ) : fail?.kind === "locked" ? (
          <div className="card">
            <Locked />
          </div>
        ) : fail?.kind === "plan" ? (
          <div className="card">
            <div className="st" style={{ boxShadow: "none" }}>
              <span className="t">지금 이용 중인 이용권에는 이 기능이 없습니다. 구독 화면에서 이용권을 바꾸면 사용할 수 있습니다</span>
            </div>
          </div>
        ) : fail?.kind === "forbidden" ? (
          <div className="card">
            <NoPermission need="오버레이 편집" />
          </div>
        ) : (
          <div className="col" style={{ gap: 16 }}>
            <div className="msg msg-cau" role="note">
              파트너스 전용 비공개 주소입니다. 이 주소를 아는 사람은 누구나 주문대기를 볼 수 있으니 방송 화면에 노출하지 마십시오.
            </div>

            <section className="card pad col" style={{ gap: 14 }} aria-labelledby="ovu-h">
              <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
                <div className="col" style={{ gap: 4, minWidth: 0 }}>
                  <h2 className="t-hl1" id="ovu-h">
                    방송 화면 주소
                  </h2>
                  <span className="t-l2 c-alt">
                    {info?.lastAccessAt ? (
                      <span className={`bdg ${info.connected ? "b-done" : "b-wait"}`} data-testid="ovu-conn">
                        {info.connected ? `연결됨 · ${info.lastClient ?? "방송 프로그램"}${info.openSources > 0 ? `, ${info.openSources}개 소스` : ""}` : "연결 끊김"}
                      </span>
                    ) : info ? (
                      <span className="bdg b-wait" data-testid="ovu-conn">
                        미연결
                      </span>
                    ) : null}{" "}
                    주소는 만들 때 한 번만 보입니다. 다시 보려면 새로 만들어 주십시오(이전 주소는 바로 쓸 수 없게 됩니다).
                    {info?.issuedAt ? ` · 발급 ${formatDate(info.issuedAt)}` : ""}
                    {info?.lastAccessAt ? ` · 마지막 접속 ${ago(info.lastAccessAt)}${info.lastClient ? ` (${info.lastClient})` : ""}` : ""}
                  </span>
                </div>
                <button className="btn" type="button" disabled={busy || (info?.live === true && info.issuedAt !== null)} onClick={() => setConfirm(true)}>
                  {issued || info?.issuedAt ? "주소 새로 만들기" : "주소 만들기"}
                </button>
              </div>

              {info?.live && info.issuedAt !== null && (
                <span className="t-c1 c-alt" data-testid="ovu-live-block">
                  방송 중에는 주소를 다시 만들 수 없습니다. 방송을 끝낸 뒤 진행해 주십시오.
                </span>
              )}
              {fail?.kind === "unclear" && (
                <div className="msg msg-cau" role="alert" data-testid="ovu-unclear">
                  새 주소를 만들었는지 확인하지 못했습니다. 이전 주소를 쓸 수 없을 수 있으니 방송 전에 주소를 새로 만들어 방송 프로그램(OBS)에 다시 넣어 주십시오.
                </div>
              )}
              {fail?.kind === "other" && (
                <div className="msg msg-neg" role="alert">
                  {fail.text}
                </div>
              )}

              {issued && (
                <>
                  <div className="msg msg-info" role="status">
                    이 주소는 지금만 볼 수 있습니다. 방송 프로그램에 넣어 두십시오. 잃어버리면 새로 만들어 주십시오.
                  </div>
                  <ul className="ovu-list" data-testid="ovu-urls">
                    {urls(issued.token).map((u) => (
                      <li key={u.key} className="ovu-row">
                        <span className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                          <span className="t-l1 fw6">
                            {u.label} <span className="t-c1 c-alt fw5">방송 프로그램 설정값 {u.size}</span>
                          </span>
                          <input className="inp inp-sm ovu-url" readOnly value={u.url} aria-label={`${u.label} 주소`} onFocus={(e) => e.currentTarget.select()} />
                        </span>
                        <span className="row" style={{ gap: 6 }}>
                          <button className="btn btn-sm" type="button" onClick={() => void copy(u.url)}>
                            주소 복사
                          </button>
                          <a className="btn btn-sm btn-out" href={u.url} target="_blank" rel="noreferrer">
                            열어 보기
                          </a>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="card pad col" style={{ gap: 10 }} aria-labelledby="ovu-how-h">
              <h2 className="t-hl1" id="ovu-how-h">
                방송 프로그램(OBS)에 추가하는 방법
              </h2>
              <table className="tbl" data-testid="ovu-how">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>순서</th>
                    <th>내용</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="num">1</td>
                    <td className="col-text">OBS 「소스」의 「+」에서 「브라우저」를 고르고 이름을 입력합니다(예: 주문대기).</td>
                  </tr>
                  <tr>
                    <td className="num">2</td>
                    <td className="col-text">「URL」 칸에 위 주소를 붙여 넣고, 세로형은 너비 1080 · 높이 1920, 가로형은 너비 1920 · 높이 1080을 넣습니다.</td>
                  </tr>
                  <tr>
                    <td className="num">3</td>
                    <td className="col-text">「소스가 보이지 않을 때 종료」는 해제하고, 「OBS로 오디오 제어」도 해제합니다.</td>
                  </tr>
                  <tr>
                    <td className="num">4</td>
                    <td className="col-text">방송 대시보드에서 「방송 시작」을 누르면 방송 화면이 LIVE로 바뀌는지 확인합니다.</td>
                  </tr>
                </tbody>
              </table>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <Link className="btn btn-out" href="/seller/inquiries">
                  연결이 안 되면 문의
                </Link>
              </div>
            </section>

            <section className="card pad col" style={{ gap: 10 }} aria-labelledby="ovu-re-h">
              <h2 className="t-hl1" id="ovu-re-h">
                재발급 이력
              </h2>
              {!info || info.reissues.length === 0 ? (
                <span className="t-l2 c-alt">아직 발급 기록이 없습니다</span>
              ) : (
                <table className="tbl" data-testid="ovu-reissues">
                  <thead>
                    <tr>
                      <th>일시</th>
                      <th>내용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {info.reissues.map((r, i) => (
                      <tr key={i}>
                        <td className="num">{formatDateTime(r.at)}</td>
                        <td className="col-text">
                          {r.kind === "first" ? "최초 발급" : "재발급"}
                          {r.by ? ` · ${r.by}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card pad col" style={{ gap: 10 }} aria-labelledby="ovu-ac-h">
              <h2 className="t-hl1" id="ovu-ac-h">
                접속 기록
              </h2>
              {!info || info.accesses.length === 0 ? (
                <span className="t-l2 c-alt" data-testid="ovu-ac-empty">
                  아직 방송 프로그램에서 접속한 적이 없습니다
                </span>
              ) : (
                <>
                  <table className="tbl" data-testid="ovu-accesses">
                    <thead>
                      <tr>
                        <th>시각</th>
                        <th>소스</th>
                        <th>레이아웃</th>
                        <th>상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {info.accesses.map((a, i) => (
                        <tr key={i}>
                          <td className="num">{formatDateTime(a.at)}</td>
                          <td className="col-text">{a.client}</td>
                          <td>{a.layout ? LAYOUT[a.layout] : "—"}</td>
                          <td>{ACCESS_STATE[a.state]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <span className="t-c1 c-alt">낯선 접속이 보이면 주소를 새로 만들어 주십시오.</span>
                </>
              )}
            </section>
          </div>
        )}
      </main>

      {confirm && <IssueConfirm again={issued !== null} busy={busy} onClose={() => setConfirm(false)} onConfirm={() => void issue()} />}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

function IssueConfirm({ again, busy, onClose, onConfirm }: { again: boolean; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="ovu-confirm-h">
      <div className="modal">
        <div className="modal-h">
          <h2 className="t-h2" id="ovu-confirm-h">
            {again ? "주소를 새로 만드시겠습니까?" : "새 주소를 만드시겠습니까?"}
          </h2>
          <span className="t-l2 c-alt">{again ? "기존 주소는 바로 쓸 수 없게 됩니다. 방송 프로그램(OBS)에 새 주소를 다시 넣어야 합니다." : "이전에 만든 주소가 있으면 바로 쓸 수 없게 됩니다. 방송 프로그램에 넣은 주소도 새 주소로 바꿔야 합니다."}</span>
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button className="btn" type="button" disabled={busy} onClick={onConfirm}>
            {again ? "주소 새로 만들기" : "주소 만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}
