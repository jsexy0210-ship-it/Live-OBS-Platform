"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import MarketingConsentDoc, { MARKETING_DOC_VERSION } from "./MarketingConsentDoc";
import MyMenu from "./MyMenu";
import ShopBack from "./ShopBack";
import ShopModal from "./ShopModal";
import { call } from "./reviewShared";
import { formatDate } from "../../lib/client/format";
import "./Cart.css";
import "./MyMenu.css";
import "./Profile.css";

// SH-024 회원정보 수정(보드 SH-024-IA FINAL): 아이디·이름(읽기 전용) · 휴대폰 번호 · 방송 닉네임* · 비밀번호 · 알림 수신 → 저장 · 취소 · 회원 탈퇴.
// API: GET /me/profile · PUT /me/nickname(30일에 1번) · POST /me/password · GET·PUT /me/marketing-consent · POST /me/withdraw { password }.
// 휴대폰 번호 바꾸기(본인확인 다시)는 서버가 아직 없어 누를 수 없게 둔다.
type Profile = { loginId: string; name: string; phoneMasked: string; broadcastNickname: string; nextNicknameChangeAt: string | null };
type Consent = { agreed: boolean; currentVersion: string };
type View = { kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; p: Profile; c: Consent | null };
const md = (iso: string) => formatDate(iso);

export default function ProfileView({ slug, shopName }: { slug: string; shopName: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}/me`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [nick, setNick] = useState("");
  const [mkt, setMkt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [modal, setModal] = useState<null | "password" | "withdraw" | "consent">(null);

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([call<Profile>(`${api}/profile`), call<Consent>(`${api}/marketing-consent`)]);
    if (!p.ok) return setView({ kind: p.status === 401 || p.status === 404 ? "login" : "error" });
    setNick(p.data.broadcastNickname);
    setMkt(c.ok ? c.data.agreed : false);
    setView({ kind: "ok", p: p.data, c: c.ok ? c.data : null });
  }, [api]);
  useEffect(() => void load(), [load]);

  async function save() {
    if (view.kind !== "ok" || busy) return;
    setBusy(true);
    setMsg(null);
    const done: string[] = [];
    const nickChanged = nick.trim() !== view.p.broadcastNickname;
    if (nickChanged) {
      const r = await call<Profile>(`${api}/nickname`, { method: "PUT", body: { broadcastNickname: nick.trim() } });
      if (!r.ok) {
        setBusy(false);
        if (r.status === 401) return setView({ kind: "login" });
        if (r.error === "nickname_change_limited") await load();
        return setMsg({ ok: false, text: r.message ?? "닉네임을 바꾸지 못했어요. 잠시 뒤 다시 해 주세요" });
      }
      done.push("nick");
    }
    // 알림 수신: 끄는 것은 바로 철회한다(켜는 것은 서식을 보여 준 뒤 「동의하고 받기」로만 한다)
    if (view.c && view.c.agreed && !mkt) {
      const r = await call(`${api}/marketing-consent`, { method: "PUT", body: { agreed: false } });
      if (!r.ok) {
        setBusy(false);
        await load();
        return setMsg({ ok: false, text: r.message ?? "알림 수신을 바꾸지 못했어요. 잠시 뒤 다시 해 주세요" });
      }
      done.push("mkt");
    }
    await load();
    setBusy(false);
    setMsg(done.length > 0 ? { ok: true, text: "회원정보를 저장했어요" } : { ok: true, text: "바뀐 내용이 없어요" });
  }

  let content: React.ReactNode;
  if (view.kind === "loading")
    content = (
      <p className="shop-empty" aria-busy="true">
        회원정보를 불러오고 있어요
      </p>
    );
  else if (view.kind === "login")
    content = (
      <div className="cart-empty">
        <p>로그인하면 볼 수 있어요</p>
        <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/me/profile`)}`}>
          로그인
        </Link>
      </div>
    );
  else if (view.kind === "error")
    content = (
      <div className="cart-empty">
        <p>불러오지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.</p>
        <button className="btn" type="button" onClick={() => void load()}>
          다시 불러오기
        </button>
      </div>
    );
  else {
    const { p, c } = view;
    const limited = p.nextNicknameChangeAt && new Date(p.nextNicknameChangeAt).getTime() > Date.now();
    content = (
      <>
        {msg && (
          <p className={`msg ${msg.ok ? "msg-pos" : "msg-neg"} t-l2`} role={msg.ok ? "status" : "alert"} style={{ display: "block" }}>
            {msg.text}
          </p>
        )}
        {limited && (
          <p className="msg msg-info t-l2" style={{ display: "block" }}>
            닉네임은 30일에 1번만 바꿀 수 있어요 · 다음 변경 {md(p.nextNicknameChangeAt!)}
          </p>
        )}
        <div className="pf-rows">
          <div className="pf-row">
            <span className="pf-th">아이디 (이메일)</span>
            <div className="pf-td">
              {p.loginId} <span className="pf-hint">바꿀 수 없어요</span>
            </div>
          </div>
          <div className="pf-row">
            <span className="pf-th">이름</span>
            <div className="pf-td">
              {p.name} <span className="pf-hint">휴대폰 본인확인 값 · 바꾸려면 다시 본인확인</span>
            </div>
          </div>
          <div className="pf-row">
            <span className="pf-th">휴대폰 번호</span>
            <div className="pf-td">
              {p.phoneMasked}{" "}
              <button className="btn btn-sm btn-out" type="button" disabled title="준비 중이에요">
                번호 바꾸기 (본인확인)
              </button>
              <span className="pf-hint">번호 바꾸기는 곧 열려요</span>
            </div>
          </div>
          <div className="pf-row">
            <label className="pf-th" htmlFor="pf-nick">
              방송 닉네임<i aria-hidden="true">*</i>
            </label>
            <div className="pf-td pf-col">
              <input id="pf-nick" className="inp" maxLength={20} value={nick} disabled={!!limited || busy} onChange={(e) => setNick(e.target.value)} />
              <span className="pf-hint">방송 화면에 보이는 이름이에요 · 30일에 1번 바꿀 수 있어요</span>
            </div>
          </div>
          <div className="pf-row">
            <span className="pf-th">비밀번호</span>
            <div className="pf-td">
              <button className="btn btn-sm btn-out" type="button" onClick={() => setModal("password")}>
                비밀번호 바꾸기
              </button>
            </div>
          </div>
          <div className="pf-row">
            <span className="pf-th">알림 수신</span>
            <div className="pf-td pf-col">
              <label className="chk">
                <input
                  type="checkbox"
                  checked={mkt}
                  disabled={!c || busy}
                  onChange={(e) => {
                    if (e.target.checked) setModal("consent");
                    else setMkt(false);
                  }}
                />
                방송 · 혜택 알림 (선택)
              </label>
              <span className="pf-hint">주문 · 배송 알림은 끌 수 없어요</span>
            </div>
          </div>
        </div>
        <div className="pf-actions">
          <button className="btn" type="button" disabled={busy || nick.trim() === ""} aria-busy={busy} onClick={() => void save()}>
            {busy ? "저장하고 있어요" : "저장"}
          </button>
          <Link className="btn btn-out" href={`${base}/me`}>
            취소
          </Link>
        </div>
        <p className="pf-withdraw">
          <button type="button" className="shop-linkbtn" onClick={() => setModal("withdraw")}>
            회원 탈퇴
          </button>
        </p>
      </>
    );
  }

  return (
    <div className="shop-wrap cart-wrap">
      <ShopBack fallback={`${base}/me`} label="내 정보" />
      <div className="cart-head">
        <h1>회원정보 수정</h1>
      </div>
      <div className="my-wrap">
        <MyMenu slug={slug} />
        <div className="pf-main">{content}</div>
      </div>
      {modal === "password" && <PasswordModal api={api} onClose={() => setModal(null)} onDone={() => { setModal(null); setMsg({ ok: true, text: "비밀번호를 바꿨어요 · 다른 기기에서는 로그아웃돼요" }); }} />}
      {modal === "withdraw" && <WithdrawModal api={api} base={base} onClose={() => setModal(null)} />}
      {modal === "consent" && (
        <ConsentModal
          api={api}
          shopName={shopName}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            setMsg({ ok: true, text: "방송 · 혜택 알림을 받아요" });
            void load();
          }}
        />
      )}
    </div>
  );
}

function PasswordModal({ api, onClose, onDone }: { api: string; onClose: () => void; onDone: () => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    if (busy) return;
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) return setErr("새 비밀번호는 영문과 숫자를 섞어 8자 이상으로 정해 주세요");
    if (next !== again) return setErr("새 비밀번호가 서로 달라요. 다시 확인해 주세요");
    setBusy(true);
    setErr(null);
    const r = await call(`${api}/password`, { method: "POST", body: { currentPassword: cur, newPassword: next } });
    setBusy(false);
    if (r.ok) return onDone();
    setErr(r.message ?? "비밀번호를 바꾸지 못했어요. 잠시 뒤 다시 해 주세요");
  }
  return (
    <ShopModal
      title="비밀번호 바꾸기"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button className="btn" type="button" disabled={busy || !cur || !next || !again} onClick={() => void submit()}>
            바꾸기
          </button>
        </>
      }
    >
      <div className="pf-modal">
        <label>
          현재 비밀번호
          <input className="inp" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </label>
        <label>
          새 비밀번호
          <input className="inp" type="password" autoComplete="new-password" aria-describedby="pf-pw-hint" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <span className="pf-hint" id="pf-pw-hint">
          8자 이상 · 영문과 숫자를 섞어 주세요
        </span>
        <label>
          새 비밀번호 확인
          <input className="inp" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        {err && (
          <p className="msg msg-neg t-l2" role="alert" style={{ display: "block" }}>
            {err}
          </p>
        )}
      </div>
    </ShopModal>
  );
}

function WithdrawModal({ api, base, onClose }: { api: string; base: string; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await call(`${api}/withdraw`, { method: "POST", body: { password: pw } });
    if (r.ok) {
      window.location.href = base;
      return;
    }
    setBusy(false);
    setErr(r.message ?? "탈퇴하지 못했어요. 잠시 뒤 다시 해 주세요");
  }
  return (
    <ShopModal
      title="정말 탈퇴하시겠어요?"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button className="btn btn-neg" type="button" disabled={busy || !pw} onClick={() => void submit()}>
            탈퇴하기
          </button>
        </>
      }
    >
      <div className="pf-modal">
        <p>남은 적립금과 쿠폰이 사라지고 되돌릴 수 없어요. 진행 중인 주문이 있으면 탈퇴할 수 없어요.</p>
        <label>
          비밀번호 확인
          <input className="inp" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        {err && (
          <p className="msg msg-neg t-l2" role="alert" style={{ display: "block" }}>
            {err}
          </p>
        )}
      </div>
    </ShopModal>
  );
}

function ConsentModal({ api, shopName, onClose, onDone }: { api: string; shopName: string; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function agree() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await call(`${api}/marketing-consent`, { method: "PUT", body: { agreed: true, marketingVersion: MARKETING_DOC_VERSION } });
    setBusy(false);
    if (r.ok) return onDone();
    setErr(r.error === "consent_outdated" ? "동의 내용이 바뀌었어요. 새로고침한 뒤 다시 해 주세요" : (r.message ?? "바꾸지 못했어요. 잠시 뒤 다시 해 주세요"));
  }
  return (
    <ShopModal
      title="방송 · 혜택 알림 받기 (선택)"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void agree()}>
            동의하고 받기
          </button>
        </>
      }
    >
      <div className="pf-modal">
        <MarketingConsentDoc shopName={shopName} />
        {err && (
          <p className="msg msg-neg t-l2" role="alert" style={{ display: "block" }}>
            {err}
          </p>
        )}
      </div>
    </ShopModal>
  );
}
