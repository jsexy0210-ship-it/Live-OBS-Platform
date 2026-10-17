"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import "./MinorPurchase.css";

// SH-009 미성년자 구매 제한 안내(보드 SH-009 · SH-009-PC, 서버 #1231: 프로필 minorPurchase, 담기·주문 403 minor_blocked · identity_reverify_required).
// 막는 쇼핑몰이면 담기·바로 주문에서 토스트 「만 19세 이상만 주문할 수 있어요」, 주문서는 안내 화면. 고지 후 허용(기본)이면 주문서에 고지 한 줄만 보이고 아무것도 막지 않는다.
export type MinorPurchase = { policy: "notice" | "block"; blocked: boolean; reverifyRequired: boolean };
export type MinorMode = "blocked" | "reverify";

const TITLE = { blocked: "이 쇼핑몰은 만 19세 이상만 주문할 수 있어요", reverify: "나이를 확인할 수 없어요" } as const;
const BODY = {
  blocked: "판매자가 미성년자 구매를 막아 두었어요. 나이는 휴대폰 본인확인의 생년월일로 확인해요. 상품은 볼 수 있어요.",
  // 생년월일 다시 확인하는 흐름(SH-024)이 생기기 전까지는 판매자에게 묻도록 안내한다
  reverify: "가입 때 받은 본인확인 정보로 나이를 확인하지 못했어요. 판매자에게 문의해 주세요. 상품은 볼 수 있어요.",
} as const;
const TOAST = { blocked: "만 19세 이상만 주문할 수 있어요", reverify: "나이를 확인할 수 없어요. 판매자에게 문의해 주세요" } as const;
export const MINOR_NOTICE = "만 19세 미만이 법정대리인 동의 없이 주문하면 본인이나 법정대리인이 취소할 수 있어요. 나이는 휴대폰 본인확인 생년월일로 확인해요.";

// 담기·주문 응답이 미성년자 제한이면 그 종류를 돌려준다
export function minorModeOf(r: { ok: boolean; status?: number; error?: string }): MinorMode | null {
  if (r.ok || r.status !== 403) return null;
  return r.error === "minor_blocked" ? "blocked" : r.error === "identity_reverify_required" ? "reverify" : null;
}
export const minorModeOfProfile = (m: MinorPurchase | null | undefined): MinorMode | null => (m?.blocked ? "blocked" : m?.reverifyRequired ? "reverify" : null);

// 화면 아래에 잠깐 뜨는 안내(보드 .toast). 같은 안내가 연속으로 눌려도 시간을 다시 센다
export function useMinorToast() {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);
  const show = (mode: MinorMode) => {
    setText(TOAST[mode]);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(null), 4000);
  };
  const node = text ? (
    <div className="minor-toast" role="status">
      <div className="toast">{text}</div>
    </div>
  ) : null;
  return { show, node };
}

// 주문서를 막을 때의 안내 화면(보드 SH-009 본판)
export function MinorState({ mode, base }: { mode: MinorMode; base: string }) {
  return (
    <div className="shop-locked-wrap">
      <section className="card shop-card shop-state minor-state" role="status">
        <span className="shop-state-ico is-text" aria-hidden>
          🔒
        </span>
        <h1 id="shop-state-title" className="t-h1" tabIndex={-1}>
          {TITLE[mode]}
        </h1>
        <p className="t-l1 c-alt">{BODY[mode]}</p>
        <div className="minor-btns">
          <Link className="btn btn-out" href={base}>
            홈으로
          </Link>
          <Link className="btn btn-out" href={`${base}/help`}>
            이용안내 보기
          </Link>
        </div>
      </section>
    </div>
  );
}
