"use client";

import { useEffect } from "react";

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

// 403: 직원에게 상품 권한이 없을 때
export function NoPermission({ need }: { need: string }) {
  return (
    <div className="st" style={{ boxShadow: "none" }}>
      <LockIcon />
      <span className="t">이 기능은 권한이 필요합니다</span>
      <span className="s">대표자에게 요청해 주십시오 · 필요한 권한: {need}</span>
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
