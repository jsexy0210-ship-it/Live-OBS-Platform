"use client";

import { useEffect, useState } from "react";

// 다음(카카오) 우편번호 서비스(무료·키 없음). 스크립트를 한 번 불러오고, 15초 안에 못 불러오면 「failed」라 화면이 직접 입력으로 바꾼다.
// 파트너스 가입(사업장 주소)과 구매자 배송지 관리가 같이 쓴다.
const POSTCODE_SRC = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
export type PostcodeData = { zonecode: string; roadAddress: string; jibunAddress: string; userSelectedType: "R" | "J"; buildingName?: string; apartment?: "Y" | "N" };
type DaumGlobal = { Postcode: new (o: { oncomplete: (d: PostcodeData) => void }) => { open: () => void } };
export function usePostcode(enabled: boolean) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    if (!enabled) return;
    const w = window as unknown as { daum?: DaumGlobal };
    if (w.daum?.Postcode) return setState("ready");
    setState("loading");
    const tag = document.createElement("script");
    tag.src = POSTCODE_SRC;
    tag.async = true;
    // 15초 안에 못 불러오면 직접 입력으로 바꾼다
    const timer = setTimeout(() => setState((p) => (p === "loading" ? "failed" : p)), 15_000);
    tag.onload = () => {
      clearTimeout(timer);
      setState((window as unknown as { daum?: DaumGlobal }).daum?.Postcode ? "ready" : "failed");
    };
    tag.onerror = () => {
      clearTimeout(timer);
      setState("failed");
    };
    document.head.appendChild(tag);
    return () => {
      clearTimeout(timer);
      tag.onload = null;
      tag.onerror = null;
    };
  }, [enabled]);
  const open = (onPick: (d: PostcodeData) => void) => {
    const w = window as unknown as { daum?: DaumGlobal };
    try {
      if (!w.daum?.Postcode) throw new Error("postcode_missing");
      new w.daum.Postcode({ oncomplete: onPick }).open();
    } catch {
      setState("failed");
    }
  };
  return { state, open };
}
