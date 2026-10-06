"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

// AU-005 승인 대기 안내의 후속 상태(정본 「후속 · 보완 요청 / 반려 / 심사 지연」). 로그인 시도에서 받은 15분 쿠키가 있을 때만 보이고
// (없으면 기본 안내만), 쿠키로 자기 신청의 상태를 읽는다(GET /api/seller/pending-application, sellers/pendingAccess.ts).
type View = {
  state: "PENDING" | "SUPPLEMENT" | "REJECTED";
  delayed: boolean;
  supplement: { reason: string | null; daysLeft: number | null } | null;
  rejectedReason: string | null;
};

export default function PendingApplication() {
  const [view, setView] = useState<View | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await api<View>("/api/seller/pending-application", { authRedirect: false });
    setView(r.ok ? r.data : null);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    setError(null);
    if (file.size > 10 * 1024 * 1024) return setError("10MB 이하 파일만 올릴 수 있습니다");
    setBusy(true);
    let res: Response | null = null;
    try {
      res = await fetch("/api/seller/pending-application/license", { method: "PUT", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file, cache: "no-store" });
    } catch {
      res = null;
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
    if (res?.ok) {
      setSent(true);
      return void load();
    }
    const body = res ? ((await res.json().catch(() => ({}))) as { message?: string; error?: string }) : {};
    setError(body.error === "not_found" ? "시간이 지났습니다. 로그인 화면에서 다시 로그인해 주십시오" : (body.message ?? "올리지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
  };

  if (!view) return null;
  if (view.state === "REJECTED") {
    return (
      <div className="col" style={{ gap: 8, alignItems: "flex-start", textAlign: "left", width: "100%" }} data-testid="pending-rejected">
        <div className="msg msg-neg" style={{ display: "block", width: "100%" }}>
          <b>이번에는 함께하지 못하게 되었습니다.</b>
          {view.rejectedReason ? ` 사유: ${view.rejectedReason}` : ""}
          {" · 사유를 해결한 뒤 다시 신청할 수 있습니다"}
        </div>
        <Link className="btn btn-sm btn-out" href="/seller/signup">
          다시 신청
        </Link>
      </div>
    );
  }
  if (view.state === "SUPPLEMENT" && view.supplement) {
    const { reason, daysLeft } = view.supplement;
    return (
      <div className="col" style={{ gap: 8, alignItems: "flex-start", textAlign: "left", width: "100%" }} data-testid="pending-supplement">
        <div className="msg msg-cau" style={{ display: "block", width: "100%" }}>
          <b>사업자등록증 사진을 다시 올려 주십시오.</b>
          {reason ? ` ${reason}` : ""}
          {daysLeft !== null ? ` · ${daysLeft}일 안에 올리지 않으면 신청이 취소됩니다` : ""}
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf" hidden onChange={(e) => void upload(e.target.files?.[0])} />
        <button className={`btn btn-sm${busy ? " is-loading" : ""}`} type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "올리고 있습니다" : "사진 다시 올리기"}
        </button>
        {error && (
          <span className="err" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 8, alignItems: "flex-start", textAlign: "left", width: "100%" }}>
      {sent && (
        <div className="msg msg-info" role="status" style={{ display: "block", width: "100%" }}>
          사업자등록증을 올렸습니다. 확인한 뒤 알려 드립니다
        </div>
      )}
      {view.delayed && (
        <div className="msg msg-info" style={{ display: "block", width: "100%" }} data-testid="pending-delayed">
          신청이 많아 조금 늦어지고 있습니다 · 곧 알려 드립니다
        </div>
      )}
    </div>
  );
}
