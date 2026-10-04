"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Tone } from "./api";

// 로그인 화면 직원 탭에서 들어오면 ?type=staff. 계정 찾기 → 비밀번호 찾기 → 로그인 복귀까지 이어 붙인다(정본: docs/IA.md AU-002·003·011).
export function useStaffType(): boolean {
  const [staff, setStaff] = useState(false);
  useEffect(() => setStaff(new URLSearchParams(window.location.search).get("type") === "staff"), []);
  return staff;
}
export const withType = (path: string, staff: boolean) => (staff ? `${path}?type=staff` : path);

// 로그인 뒤 돌아갈 주소(?next=). 파트너스 화면 안의 주소로만 돌려보낸다(다른 사이트로 넘기지 않음)
export function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && /^\/seller(\/[\w\-/]*)?$/.test(next) && next !== "/seller/login" && next !== "/seller/identity-link" ? next : "/seller/products";
}

// 로그인 밖 파트너스 화면(로그인 · 가입 신청 · 비밀번호 찾기) 공통 틀: 가운데 로고와 카드
export function AuthFrame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const staff = useStaffType();
  return (
    <div className="login-page">
      <Link className="logo" href={withType("/seller/login", staff)} style={{ fontSize: 22 }} aria-label="파트너스 로그인으로">
        <span className="logo-sym" />
        <span className="logo-word" />
        <span className="t-l1 c-alt" style={{ marginLeft: 6 }}>
          파트너스
        </span>
      </Link>
      <div className={`card col login-card${wide ? " pa-wide" : ""}`}>{children}</div>
    </div>
  );
}

// 단계 표시(1 본인확인 → 2 정보 입력 → 3 신청 완료). 지난 단계와 지금 단계는 채운 원
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="pa-steps" aria-label="진행 단계">
      {steps.map((s, i) => (
        <li key={s} className={i <= current ? "on" : ""} aria-current={i === current ? "step" : undefined}>
          <span className="pa-step-n">{i + 1}</span>
          <span className={i === current ? "fw7" : "c-alt"}>{s}</span>
        </li>
      ))}
    </ol>
  );
}

// 본인확인 대행사 연결 전(API 503 「본인확인 서비스 준비 중이에요」) 상태 화면
// action: 「가입을 신청할」·「비밀번호를 찾을」
// tone: admin(관리자 인증 화면, 기본) · public(가입 신청)
export function IdentityUnavailable({ action, tone = "admin" }: { action: string; tone?: Tone }) {
  const staff = useStaffType();
  const pub = tone === "public";
  return (
    <div className="st" style={{ boxShadow: "none", padding: "24px 0" }}>
      <div className="st-ic">!</div>
      <h2 className="t" id="pa-state-title" tabIndex={-1}>
        {pub ? "본인확인 서비스 준비 중이에요" : "본인확인 서비스 준비 중입니다"}
      </h2>
      <span className="s">
        {pub ? `휴대폰 본인확인을 연결하고 있어요. 준비되면 바로 ${action} 수 있어요.` : `휴대폰 본인확인을 연결하고 있습니다. 준비되면 바로 ${action} 수 있습니다.`}
      </span>
      <Link className="btn btn-sm btn-out" href={withType("/seller/login", staff)}>
        로그인으로 돌아가기
      </Link>
    </div>
  );
}
