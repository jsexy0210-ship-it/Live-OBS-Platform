"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import IdentityCheck from "../../../../components/seller/IdentityCheck";
import { AuthFrame, IdentityUnavailable, safeNext } from "../../../../components/seller/PartnersAuth";
import { api, failMessage } from "../../../../components/seller/api";

// AU-012 직원 본인확인 연결(직원 로그인 뒤, 연결 전이면 로그인 화면이 이리로 보낸다). 건너뛸 수 있다(「나중에 할게요」).
// 연결은 직원이 아이디·비밀번호를 스스로 찾을 때만 쓴다. 연결 전에도 로그인·권한은 그대로다.
// 대표자가 SA-100에서 등록한 이름·휴대폰과 본인확인 결과가 같아야 연결된다. 대표자가 번호를 바꾸면 연결이 풀려 다시 이 화면이 뜬다.
// API: GET /api/seller/me/identity { phoneRegistered, linked } → POST start(·resend·confirm) → POST link { verificationId }.
const BASE = "/api/seller/me/identity";

type Status = { phoneRegistered: boolean; linked: boolean };

export default function IdentityLinkPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [done, setDone] = useState(false);
  const [idvKey, setIdvKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusTo, setFocusTo] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    document.getElementById(focusTo.id)?.focus();
    setFocusTo(null);
  }, [focusTo]);
  const focus = (id: string) => setFocusTo({ id });
  const later = () => router.replace(safeNext());

  // 로그인 전이면 로그인으로, 대표자이거나 이미 연결했으면 바로 다음 화면으로
  useEffect(() => {
    void api<Status>(BASE).then((r) => {
      if (r.ok && !r.data.linked) return setStatus(r.data);
      if (r.status === 401) return router.replace(`/seller/login?type=staff&next=${encodeURIComponent(safeNext())}`);
      router.replace(safeNext());
    });
  }, [router]);

  const link = async (verificationId: string) => {
    setBusy(true);
    setNotice(null);
    const r = await api(`${BASE}/link`, { method: "POST", body: { verificationId } });
    setBusy(false);
    if (r.ok) {
      setPending(null);
      setDone(true);
      return focus("il-title");
    }
    if (r.status === 503) return setUnavailable(true);
    if (r.error === "verification_pending") {
      setPending(verificationId);
      setNotice("본인확인 결과를 확인하고 있어요. 잠시 뒤 다시 눌러 주세요");
      return focus("pa-notice");
    }
    // 정보가 맞지 않거나 다시 해야 하는 본인확인: 칸을 비우고 처음부터
    setPending(null);
    setIdvKey((k) => k + 1);
    setNotice(failMessage(r, "연결하지 못했어요. 처음부터 다시 해 주세요"));
    focus("pa-notice");
  };

  if (!status) {
    return (
      <AuthFrame>
        <div className="row" style={{ justifyContent: "center", padding: 24 }}>
          <span className="spin" aria-label="불러오고 있어요" />
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-t3" id="il-title" tabIndex={-1}>
          {done ? "본인확인을 연결했어요" : "본인확인을 연결해 주세요"}
        </h1>
        <span className="t-l2 c-alt">
          {done ? "이제 아이디와 비밀번호를 직접 찾을 수 있어요." : "연결해 두면 아이디나 비밀번호를 잊었을 때 직접 찾을 수 있어요."}
        </span>
      </div>
      {done ? (
        <button className="btn btn-lg btn-block" type="button" onClick={later}>
          계속하기
        </button>
      ) : unavailable ? (
        <>
          <IdentityUnavailable action="연결할" />
          <button className="btn btn-lg btn-block" type="button" onClick={later}>
            나중에 할게요
          </button>
        </>
      ) : (
        <>
          {notice && (
            <div id="pa-notice" tabIndex={-1} className="msg msg-neg" role="alert" style={{ display: "block" }}>
              {notice}
              {pending && (
                <span className="row" style={{ marginTop: 8 }}>
                  <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void link(pending)}>
                    다시 확인하기
                  </button>
                </span>
              )}
            </div>
          )}
          {status.phoneRegistered ? (
            <>
              <div className="msg msg-info" style={{ display: "block" }}>
                대표자가 등록한 이름과 휴대폰 번호로 확인해요. 휴대폰 번호가 바뀌면 다시 연결해 주세요.
              </div>
              <IdentityCheck
                key={idvKey}
                label="휴대폰 본인확인"
                base={BASE}
                blocked={busy}
                start={(person) => api<{ verificationId: string }>(`${BASE}/start`, { method: "POST", body: person })}
                onUnavailable={() => setUnavailable(true)}
                onVerified={(id) => void link(id)}
              />
            </>
          ) : (
            <div className="msg msg-info" role="status" style={{ display: "block" }}>
              등록된 휴대폰 번호가 없어요. 대표자에게 번호 등록을 요청해 주세요
            </div>
          )}
          <button className="btn btn-lg btn-block btn-out" type="button" onClick={later}>
            나중에 할게요
          </button>
        </>
      )}
    </AuthFrame>
  );
}
