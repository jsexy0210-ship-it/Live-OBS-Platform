"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import IdentityCheck from "../../../../components/seller/IdentityCheck";
import { AuthFrame, IdentityUnavailable, safeNext } from "../../../../components/seller/PartnersAuth";
import { api, failMessage, type ApiResult, type Me } from "../../../../components/seller/api";
import { stepOutcome } from "../../../../components/seller/stepFailure";

// AU-012 직원 본인확인으로 계정 연결(정본: docs/IA.md AU-012, 디자인 AU-012). 연결 전 직원이 로그인하면 로그인 화면이 이리로 보낸다.
// 연결은 직원이 아이디·비밀번호를 스스로 찾을 때만 쓴다. 연결 전이나 건너뛴 뒤에도 로그인·업무는 그대로다(「나중에 하기」).
// 대표자가 SA-100에서 등록한 이름·휴대폰과 본인확인 결과가 같아야 연결된다. 다르면 대표자에게 정보 수정을 부탁하게 안내한다.
// 대표자가 번호를 바꿔 연결이 풀렸으면(relinkRequired) 「본인확인 재시도」로 안내한다.
// API: GET /api/seller/me/identity { available, phoneRegistered, registeredPhoneLast4, linked, relinkRequired } → POST start(·resend·confirm) → POST link { verificationId }.
const BASE = "/api/seller/me/identity";

type Status = { available: boolean; phoneRegistered: boolean; registeredPhoneLast4: string | null; linked: boolean; relinkRequired: boolean };
type View = "form" | "relink" | "mismatch" | "done";

// 등록 정보와 다르면(identity_mismatch) 대표자에게 정보 수정을 부탁하는 화면으로 바꾼다
const isMismatch = (r: ApiResult<unknown>) => !r.ok && r.error === "identity_mismatch";

export default function IdentityLinkPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("form");
  const [unavailable, setUnavailable] = useState(false);
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

  // 로그인 전이면 직원 탭 로그인으로(원래 가려던 곳을 담아 한 번만 이동), 대표자이거나 이미 연결했으면 바로 다음 화면으로
  useEffect(() => {
    void api<Status>(BASE, { authRedirect: false }).then((r) => {
      if (r.ok && !r.data.linked) {
        setStatus(r.data);
        if (r.data.relinkRequired) setView("relink");
        void api<Me>("/api/seller/me").then((m) => m.ok && setMe(m.data));
        return;
      }
      if (r.status === 401) return router.replace(`/seller/login?type=staff&next=${encodeURIComponent(safeNext())}`);
      router.replace(safeNext());
    });
  }, [router]);

  const toMismatch = () => {
    setPending(null);
    setNotice(null);
    setView("mismatch");
    focus("il-state");
  };

  const link = async (verificationId: string) => {
    setBusy(true);
    setNotice(null);
    const r = await api(`${BASE}/link`, { method: "POST", body: { verificationId } });
    setBusy(false);
    if (r.ok) {
      setPending(null);
      setView("done");
      return focus("il-title");
    }
    const out = stepOutcome(r);
    if (out === "unavailable") return setUnavailable(true);
    // 응답을 놓쳤거나(연결 끊김) 잠깐의 서버 오류면 저장됐을 수 있다: 본인확인을 버리지 않고 연결 상태를 다시 읽는다.
    // 연결됐으면 완료로, 아니면 같은 본인확인으로 다시 누를 수 있게 둔다(유료 문자 본인확인을 다시 하지 않게)
    if (out === "retry") {
      const st = await api<Status>(BASE, { authRedirect: false });
      if (st.ok && st.data.linked) {
        setPending(null);
        setView("done");
        return focus("il-title");
      }
      setPending(verificationId);
      setNotice("확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오");
      return focus("pa-notice");
    }
    if (isMismatch(r)) return toMismatch();
    // 서버가 본인확인을 다시 하라고 한 경우만 칸을 비우고 처음부터
    if (out === "restart") {
      setPending(null);
      setIdvKey((k) => k + 1);
      setNotice(failMessage(r, "admin", "본인확인을 처음부터 다시 해 주십시오"));
      return focus("pa-notice");
    }
    // 결과를 아직 받는 중이거나 그 밖의 거절: 본인확인을 버리지 않고 안내만 한다
    setPending(verificationId);
    setNotice(r.error === "verification_pending" ? "본인 확인 결과를 기다리는 중입니다. 잠시 뒤 다시 눌러 주십시오" : failMessage(r, "admin", "확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오"));
    focus("pa-notice");
  };

  if (!status) {
    return (
      <AuthFrame>
        <div className="row" style={{ justifyContent: "center", padding: 24 }}>
          <span className="spin" aria-label="불러오는 중" />
        </div>
      </AuthFrame>
    );
  }

  const laterLinks = (
    <div className="row t-l2 c-alt" style={{ justifyContent: "center", gap: 20 }}>
      <button className="btn btn-sm btn-text" type="button" onClick={later}>
        나중에 하기
      </button>
      {/* 상태를 받은 뒤(브라우저)에만 그려지므로 safeNext()로 원래 가려던 곳을 함께 넘긴다 */}
      <Link href={`/seller/login?type=staff&next=${encodeURIComponent(safeNext())}`}>다른 계정으로 로그인</Link>
    </div>
  );

  if (view === "done") {
    return (
      <AuthFrame>
        <div className="col" style={{ gap: 14, alignItems: "center", textAlign: "center" }}>
          <h1 className="t-t3" id="il-title" tabIndex={-1}>
            계정을 연결했습니다
          </h1>
          <span className="t-l2 c-alt">이제 아이디 · 비밀번호를 직접 찾을 수 있습니다. 다음 로그인부터는 이메일과 비밀번호만으로 로그인합니다.</span>
          <button className="btn btn-lg btn-block" type="button" onClick={later}>
            계속
          </button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-t3" id="il-title" tabIndex={-1}>
          휴대폰 확인으로 내 계정 확인하기
        </h1>
        <span className="t-l2 c-alt">처음 로그인할 때 한 번만 합니다. 대표자가 등록한 직원 정보와 내 휴대폰 정보가 같은지 확인합니다.</span>
      </div>
      {me && (
        <div className="col il-info t-l2" data-testid="il-account">
          <div className="row between">
            <span className="c-alt">로그인한 계정</span>
            <span>{me.user.email}</span>
          </div>
          <div className="row between">
            <span className="c-alt">쇼핑몰</span>
            <span>{me.shop.name} · 직원</span>
          </div>
          <div className="row between">
            <span className="c-alt">대표자가 등록한 정보</span>
            <span>
              {me.user.name}
              {status.registeredPhoneLast4 && (
                <>
                  {" · "}
                  <span className="nw">휴대폰 끝자리 {status.registeredPhoneLast4}</span>
                </>
              )}
            </span>
          </div>
        </div>
      )}
      {unavailable ? (
        <IdentityUnavailable tone="admin" action="연결할" />
      ) : view === "mismatch" ? (
        <div className="col" style={{ gap: 10 }}>
          <div id="il-state" tabIndex={-1} className="msg msg-cau" role="alert" style={{ display: "block" }}>
            <span>
              <b>대표자가 등록한 정보와 다릅니다.</b> 이름이나 휴대폰 번호가 다릅니다. 대표자에게 정보를 고쳐 달라고 요청해 주십시오
            </span>
          </div>
          <span className="t-c1 c-alt">본인확인 결과는 저장하지 않았습니다 · 로그인 · 업무는 그대로입니다 · 수정되면 다음 로그인 때 다시 연결합니다</span>
          <button className="btn btn-lg btn-block btn-out" type="button" onClick={later}>
            나중에 하기
          </button>
        </div>
      ) : view === "relink" ? (
        <div className="col" style={{ gap: 10 }}>
          <div id="il-state" tabIndex={-1} className="msg msg-cau" role="status" style={{ display: "block" }}>
            <span>
              <b>휴대폰 번호가 바뀌어 본인확인을 다시 해야 아이디 · 비밀번호를 직접 찾을 수 있습니다.</b> 다시 연결하기 전까지는 대표자에게 요청해 주십시오. 다른 메뉴는 그대로 사용할 수 있습니다.
            </span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" type="button" onClick={() => setView("form")}>
              휴대폰 확인 다시 하기
            </button>
            <button className="btn btn-sm btn-out" type="button" onClick={later}>
              나중에 하기
            </button>
          </div>
        </div>
      ) : status.phoneRegistered ? (
        <>
          {notice && (
            <div id="pa-notice" tabIndex={-1} className="msg msg-neg" role="alert" style={{ display: "block" }}>
              {notice}
              {pending && (
                <span className="row" style={{ marginTop: 8 }}>
                  <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void link(pending)}>
                    결과 다시 확인하기
                  </button>
                </span>
              )}
            </div>
          )}
          <IdentityCheck tone="admin"
            key={idvKey}
            label="휴대폰 본인확인"
            base={BASE}
            blocked={busy}
            start={async (person, attemptKey) => {
              const r = await api<{ verificationId: string }>(`${BASE}/start`, { method: "POST", body: { ...person, attemptKey } });
              // 입력한 이름·번호가 등록 정보와 다르면 문자 없이 409: 칸 안 안내 대신 대표자에게 수정을 부탁하는 화면으로
              if (isMismatch(r)) toMismatch();
              return r;
            }}
            onUnavailable={() => setUnavailable(true)}
            onVerified={(id) => void link(id)}
          />
          <span className="t-c1 c-alt">지금 연결하지 않아도 로그인 · 업무는 그대로입니다 · 연결 전에는 아이디 · 비밀번호를 직접 찾을 수 없습니다 · 다음 로그인 때 다시 안내합니다</span>
        </>
      ) : (
        <div className="msg msg-cau" role="status" style={{ display: "block" }}>
          <span>
            <b>등록된 휴대폰 번호가 없습니다.</b> 대표자에게 직원 계정 관리에서 번호 등록을 요청해 주십시오. 로그인 · 업무는 그대로입니다.
          </span>
        </div>
      )}
      {(unavailable || view === "form") && laterLinks}
    </AuthFrame>
  );
}
