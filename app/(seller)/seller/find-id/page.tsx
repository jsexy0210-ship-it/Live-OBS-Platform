"use client";

import Link from "next/link";
import { AuthFrame, IdentityUnavailable, useStaffType, withType } from "../../../../components/seller/PartnersAuth";

// AU-011 아이디 찾기(정본: docs/IA.md AU-011). 대표자·직원 본인 휴대폰 본인확인 → 가입한 로그인 이메일을 보여 준다.
// 서버 API(app/api/seller/find-id/*)는 기반 세션이 만든다. 아직 없어 지금은 준비 중 상태만 보여 주고,
// API가 나오면 비밀번호 찾기와 같은 본인확인 칸(IdentityCheck)을 붙인다.
export default function FindIdPage() {
  const staff = useStaffType();
  return (
    <AuthFrame>
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-t3">아이디를 찾아요</h1>
        <span className="t-l2 c-alt">휴대폰 본인확인을 하면 가입한 로그인 이메일을 보여 드려요.</span>
      </div>
      <IdentityUnavailable action="아이디를 찾을" />
      <div className="row t-l2 c-alt" style={{ justifyContent: "center", gap: 8 }}>
        <Link href={withType("/seller/password-reset", staff)}>비밀번호 찾기</Link>
      </div>
    </AuthFrame>
  );
}
