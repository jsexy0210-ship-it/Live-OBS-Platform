"use client";

import Link from "next/link";
import { useEffect, useId } from "react";
import { useSmartBack } from "../../lib/client/navigation";

// 화면 상태 변형(빈 상태·불러오는 중·오류·권한 없음·잠금). 시안의 .st 모양을 그대로 쓴다.

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="st" style={{ boxShadow: "none" }} aria-busy="true" aria-label="불러오는 중">
      <div className="lines">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="sk" style={{ height: 36, width: i === rows - 1 ? "70%" : undefined }} />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div className="st" style={{ boxShadow: "none" }}>
      <div className="st-ic neg">!</div>
      <span className="t">{title}</span>
      <button className="btn btn-sm" type="button" onClick={onRetry}>
        다시 시도
      </button>
    </div>
  );
}

function LockIcon() {
  return (
    <div className="st-ic lock">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    </div>
  );
}

// AU-008: 기존 판매자 호출은 need/대표자 안내를 유지하며 마스터는 명시적으로 구분한다.
type NoPermissionProps = (
  | { need: string; audience?: "seller"; readOnly?: never }
  | { audience: "master"; need?: never; readOnly?: boolean }
) & { onRequest?: () => void };
export function NoPermission({ need, audience = "seller", readOnly = false, onRequest }: NoPermissionProps) {
  const titleId = useId();
  const master = audience === "master";
  const goBack = useSmartBack(master ? "/admin" : "/seller");
  const Heading = master ? "h1" : "h2";
  return (
    <div className="col" style={{ alignItems: "center", padding: "56px 0 40px" }}>
      <section className="card col login-card" style={{ width: 420 }} aria-labelledby={titleId} data-testid="permission-card">
        <div className="row" style={{ gap: 8 }}>
          <span className="logo" aria-label="ONQ"><span className="logo-sym" /><span className="logo-word" /></span>
          <span className="t-l2 c-alt">{master ? "마스터 관리자" : "파트너스 관리자"}</span>
        </div>
        <div className="col login-head" style={{ alignItems: "stretch", textAlign: "left" }}>
          <Heading className="t-t3" id={titleId} style={{ fontSize: "var(--ui-fs-title-admin)", lineHeight: "var(--ui-lh-title-admin)" }}>{master ? "이 화면을 볼 권한이 없습니다" : need === "대표자" ? "이 메뉴는 파트너스 대표만 쓸 수 있습니다" : "이 계정은 이 일을 할 수 없습니다"}</Heading>
          <p className="t-l2 c-alt" style={{ margin: 0 }}>{master ? `${readOnly ? "조회 전용 역할입니다. " : ""}권한이 필요하면 최고관리자에게 요청해 주십시오.` : `대표자에게 허용해 달라고 요청해 주십시오${need ? ` · 필요한 권한: ${need}` : ""}`}</p>
        </div>
        {onRequest && <button className="btn" type="button" onClick={onRequest}>권한 요청</button>}
        <div className="row" style={{ justifyContent: "center", gap: 16 }}>
          <button className="btn btn-text" type="button" onClick={goBack}>이전 화면</button>
          {!master && <Link href="/seller" className="t-l2">파트너스 관리자로</Link>}
        </div>
      </section>
    </div>
  );
}

// 402: 체험·이용 기간이 끝나 잠긴 판매자
export function Locked() {
  return (
    <div className="st" style={{ boxShadow: "none" }}>
      <LockIcon />
      <span className="t">이용 기간이 끝나 지금은 사용할 수 없습니다</span>
      <span className="s">구독하면 바로 다시 사용할 수 있습니다</span>
    </div>
  );
}

export function Toast({ text, onDone, neg }: { text: string; onDone: () => void; neg?: boolean }) {
  // 같은 문구가 떠 있는 동안 3초 뒤 한 번 닫는다
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="toast-wrap" role="status">
      <div className={`toast${neg ? " toast-neg" : ""}`}>
        <span className="tdot" />
        {text}
      </div>
    </div>
  );
}

// 상품 이미지가 아직 없을 때 자리에 두는 그림(글자 대신)
export function NoImage({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m21 16-5-5-8 9" />
    </svg>
  );
}
