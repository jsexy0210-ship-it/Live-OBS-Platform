"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import IdentityCheck from "../../../../components/seller/IdentityCheck";
import { AuthFrame, IdentityUnavailable, safeNext } from "../../../../components/seller/PartnersAuth";
import { api, failMessage, type ApiResult, type Me } from "../../../../components/seller/api";

// AU-012 직원 본인확인으로 계정 연결(정본: docs/IA.md AU-012, 디자인 AU-012). 연결 전 직원이 로그인하면 로그인 화면이 이리로 보낸다.
// 연결은 직원이 아이디·비밀번호를 스스로 찾을 때만 쓴다. 연결 전이나 건너뛴 뒤에도 로그인·업무는 그대로다(「나중에 할게요」).
// 대표자가 SA-100에서 등록한 이름·휴대폰과 본인확인 결과가 같아야 연결된다. 다르면 대표자에게 정보 수정을 부탁하게 안내한다.
// 대표자가 번호를 바꿔 연결이 풀렸으면(relinkRequired) 「본인확인 다시 하기」로 안내한다.
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
    if (r.status === 503) return setUnavailable(true);
    if (isMismatch(r)) return toMismatch();
    if (r.error === "verification_pending") {
      setPending(verificationId);
      setNotice("본인확인 결과를 확인하고 있어요. 잠시 뒤 다시 눌러 주세요");
      return focus("pa-notice");
    }
    // 다시 해야 하는 본인확인: 칸을 비우고 처음부터
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

  const laterLinks = (
    <div className="row t-l2 c-alt" style={{ justifyContent: "center", gap: 20 }}>
      <button className="btn btn-sm btn-text" type="button" onClick={later}>
        나중에 할게요
      </button>
      <Link href="/seller/login?type=staff">다른 계정으로 로그인</Link>
    </div>
  );

  if (view === "done") {
    return (
      <AuthFrame>
        <div className="col" style={{ gap: 14, alignItems: "center", textAlign: "center" }}>
          <h1 className="t-t3" id="il-title" tabIndex={-1}>
            계정을 연결했어요
          </h1>
          <span className="t-l2 c-alt">이제 아이디 · 비밀번호를 스스로 찾을 수 있어요. 다음 로그인부터는 이메일과 비밀번호만으로 들어와요.</span>
          <button className="btn btn-lg btn-block" type="button" onClick={later}>
            계속하기
          </button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-t3" id="il-title" tabIndex={-1}>
          본인확인으로 계정을 연결해요
        </h1>
        <span className="t-l2 c-alt">처음 로그인할 때 한 번만 해요. 대표자가 등록한 직원 정보와 맞는지 휴대폰 본인확인으로 확인해요.</span>
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
        <IdentityUnavailable action="연결할" />
      ) : view === "mismatch" ? (
        <div className="col" style={{ gap: 10 }}>
          <div id="il-state" tabIndex={-1} className="msg msg-cau" role="alert" style={{ display: "block" }}>
            <span>
              <b>대표자가 등록한 직원 정보와 맞지 않아요.</b> 이름이나 휴대폰 번호가 달라요. 대표자에게 정보 수정을 부탁해 주세요
            </span>
          </div>
          <span className="t-c1 c-alt">본인확인 결과는 저장하지 않았어요 · 로그인 · 업무는 그대로예요 · 고쳐지면 다음 로그인 때 다시 연결해요</span>
          <button className="btn btn-lg btn-block btn-out" type="button" onClick={later}>
            나중에 할게요
          </button>
        </div>
      ) : view === "relink" ? (
        <div className="col" style={{ gap: 10 }}>
          <div id="il-state" tabIndex={-1} className="msg msg-cau" role="status" style={{ display: "block" }}>
            <span>
              <b>휴대폰 번호가 바뀌어서 본인확인을 다시 해야 아이디 · 비밀번호를 스스로 찾을 수 있어요.</b> 다시 연결하기 전까지는 대표자에게 요청해 주세요. 다른 메뉴는 그대로 써요.
            </span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" type="button" onClick={() => setView("form")}>
              본인확인 다시 하기
            </button>
            <button className="btn btn-sm btn-out" type="button" onClick={later}>
              나중에 할게요
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
                    다시 확인하기
                  </button>
                </span>
              )}
            </div>
          )}
          <IdentityCheck
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
          <span className="t-c1 c-alt">지금 연결하지 않아도 로그인 · 업무는 그대로예요 · 연결 전에는 아이디 · 비밀번호를 스스로 찾을 수 없어요 · 다음 로그인 때 다시 안내해요</span>
        </>
      ) : (
        <div className="msg msg-cau" role="status" style={{ display: "block" }}>
          <span>
            <b>등록된 휴대폰 번호가 없어요.</b> 대표자에게 직원 계정 관리에서 번호 등록을 부탁해 주세요. 로그인 · 업무는 그대로예요.
          </span>
        </div>
      )}
      {(unavailable || view === "form") && laterLinks}
    </AuthFrame>
  );
}
