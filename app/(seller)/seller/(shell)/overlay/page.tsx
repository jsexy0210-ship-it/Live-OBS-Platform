"use client";

import "../../../../../styles/seller-overlay.css";
import { useEffect, useState } from "react";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";

// 메뉴 「오버레이 편집기」 자리. 지금은 SA-052 오버레이 주소 발급·재발급만 있고, 편집(SA-051)은 설정 저장 API가 생기면 붙인다.
// 주소의 토큰은 서버에 해시로만 남아 지금 쓰는 주소를 다시 보여 줄 수 없다: 발급할 때 이 화면에서 한 번만 보이고,
// 다시 발급하면 이전 주소는 바로 끊긴다(OBS에 넣은 주소도 바꿔야 한다).
// 결과가 불분명하면(연결 끊김·서버 오류) 발급됐는지 알 수 없으므로 성공으로 보이지 않고, 이전 주소가 끊겼을 수 있다고 알린다.
// API: POST /api/seller/overlay/token(OVERLAY_EDIT)

type Issued = { token: string; at: number };
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
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const issue = async () => {
    setBusy(true);
    setFail(null);
    const r = await api<{ token: string }>("/api/seller/overlay/token", { method: "POST", body: {} });
    setBusy(false);
    setConfirm(false);
    if (r.ok) {
      setIssued({ token: r.data.token, at: Date.now() });
      return setToast({ text: "새 주소를 발급했습니다" });
    }
    // 불분명: 서버가 이미 새 주소를 만들고 이전 주소를 끊었을 수 있어 보이던 주소도 지운다(끊긴 주소를 OBS에 넣지 않게)
    if (r.status === 0 || r.status >= 500) {
      setIssued(null);
      return setFail({ kind: "unclear" });
    }
    if (r.status === 402) return setFail({ kind: "locked" });
    if (r.status === 403) return setFail({ kind: r.error === "plan_feature_required" ? "plan" : "forbidden" });
    setFail({ kind: "other", text: failMessage(r, "admin") });
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setToast({ text: "주소를 복사했습니다" });
    } catch {
      setToast({ text: "복사하지 못했습니다. 주소를 직접 선택해 복사해 주십시오", neg: true });
    }
  };

  return (
    <>
      <Topbar crumb="방송 · 오버레이 › 오버레이 편집기" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">오버레이 편집기</h1>
            <span className="t-l2 c-alt">OBS 「브라우저 소스」에 오버레이 주소를 넣으면 주문대기와 개봉 중인 주문이 방송 화면에 표시됩니다.</span>
          </div>
        </div>

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
              <span className="t">현재 플랜에서 제공하지 않는 기능입니다</span>
            </div>
          </div>
        ) : fail?.kind === "forbidden" ? (
          <div className="card">
            <NoPermission need="오버레이 편집" />
          </div>
        ) : (
          <div className="col" style={{ gap: 16 }}>
            <section className="card pad col" style={{ gap: 14 }} aria-labelledby="ovu-h">
              <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
                <div className="col" style={{ gap: 4, minWidth: 0 }}>
                  <h2 className="t-hl1" id="ovu-h">
                    오버레이 주소
                  </h2>
                  <span className="t-l2 c-alt">주소는 발급할 때 한 번만 보입니다. 다시 발급하면 이전 주소는 바로 끊깁니다.</span>
                </div>
                <button className="btn" type="button" disabled={busy} onClick={() => setConfirm(true)}>
                  {issued ? "다시 발급" : "주소 발급"}
                </button>
              </div>

              {fail?.kind === "unclear" && (
                <div className="msg msg-cau" role="alert" data-testid="ovu-unclear">
                  발급 결과를 확인하지 못했습니다. 이전 주소가 이미 끊겼을 수 있습니다. 방송 전에 다시 발급해 OBS 주소를 바꿔 주십시오.
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
                    이 주소는 지금만 볼 수 있습니다. OBS에 넣은 뒤 잃어버리면 재발급해 주십시오.
                  </div>
                  <ul className="ovu-list" data-testid="ovu-urls">
                    {urls(issued.token).map((u) => (
                      <li key={u.key} className="ovu-row">
                        <span className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                          <span className="t-l1 fw6">
                            {u.label} <span className="t-c1 c-alt fw5">OBS 브라우저 소스 {u.size}</span>
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

            <section className="card pad col" style={{ gap: 6 }} aria-labelledby="ovu-edit-h">
              <h2 className="t-hl1" id="ovu-edit-h">
                화면 편집
              </h2>
              <span className="t-l2 c-alt" data-testid="ovu-edit-soon">
                준비 중입니다. 지금은 기본 템플릿(현재 주문 카드 · 주문대기)으로 표시됩니다.
              </span>
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
            {again ? "주소를 다시 발급하시겠습니까?" : "새 주소를 발급하시겠습니까?"}
          </h2>
          <span className="t-l2 c-alt">{again ? "기존 OBS 주소는 바로 끊깁니다. OBS에 새 주소를 다시 넣어야 합니다." : "이전에 발급한 주소가 있으면 바로 끊깁니다. OBS에 넣은 주소도 새 주소로 바꿔야 합니다."}</span>
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            닫기
          </button>
          <button className="btn" type="button" disabled={busy} onClick={onConfirm}>
            발급
          </button>
        </div>
      </div>
    </div>
  );
}
