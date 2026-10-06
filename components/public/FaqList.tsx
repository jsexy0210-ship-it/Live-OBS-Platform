"use client";

import { useMemo, useState } from "react";

// 질문·답은 디자인 PF-001·002·003·004 문구에서 가져온 것만 쓴다.
export const FAQ_ITEMS: { cat: string; q: string; a: string }[] = [
  { cat: "시작하기", q: "가입 심사는 얼마나 걸리나요?", a: "자동 점검을 통과하면 바로 승인돼요. 보완이 필요하면 안내해 드려요." },
  { cat: "방송 · 방송 화면", q: "OBS 말고 다른 방송 프로그램도 되나요?", a: "브라우저 소스를 넣을 수 있는 프로그램이면 돼요. 세로 1080×1920, 가로 1920×1080 크기로 맞춰 두었어요." },
  { cat: "방송 · 방송 화면", q: "세로 방송에서 방송 화면이 채팅에 가려요.", a: "유튜브 채팅이 가리는 영역을 피해 위쪽에만 패널을 둬요. 템플릿은 세로 9:16과 가로 16:9 중 골라요." },
  { cat: "방송 · 방송 화면", q: "구매자 실명이 방송에 나가나요?", a: "방송 화면에는 구매자가 정한 방송 닉네임과 상품이 떠요." },
  { cat: "결제 · 요금", q: "결제는 어디로 들어오나요?", a: "결제 대금은 파트너스 이름으로 만든 결제 대행 계정으로 바로 들어와요. ONQ는 판매 수수료를 받지 않아요." },
  { cat: "적립금", q: "적립금은 실제 돈인가요?", a: "등급별 적립률을 파트너스가 정해요. 적립금을 주고 거둔 기록이 모두 남아요. 실제 지급은 파트너스가 켜야 시작돼요." },
  { cat: "계정 · 권한", q: "직원에게 어디까지 맡길 수 있나요?", a: "직원 계정을 만들고 권한을 나눌 수 있어요." },
  { cat: "쇼핑몰 · 주문", q: "내 도메인을 쓸 수 있나요?", a: "기본 주소를 바로 받고, 내 도메인도 연결할 수 있어요." },
];

const CATS = ["전체", ...Array.from(new Set(FAQ_ITEMS.map((f) => f.cat)))];

export function FaqList() {
  const [cat, setCat] = useState("전체");
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const k = q.trim().toLowerCase();
    return FAQ_ITEMS.filter((f) => (cat === "전체" || f.cat === cat) && (!k || `${f.q} ${f.a}`.toLowerCase().includes(k)));
  }, [cat, q]);
  return (
    <>
      <div className="pf-faq-search">
        <label className="t-l2" htmlFor="faq-q">
          질문 검색
        </label>
        <input id="faq-q" className="inp" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="궁금한 것을 검색해요" />
      </div>
      <div className="pf-chips" role="group" aria-label="분류">
        {CATS.map((c) => (
          <button key={c} type="button" className={`chip${c === cat ? " on" : ""}`} aria-pressed={c === cat} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="pf-faq pf-faq-wide">
        {rows.length === 0 ? (
          <p className="t-b2 c-alt" role="status">
            맞는 질문이 없어요. 다른 말로 검색해 보세요.
          </p>
        ) : (
          rows.map((f) => (
            <details key={f.q}>
              <summary className="t-hl2">{f.q}</summary>
              <p className="t-b2 c-neu">{f.a}</p>
            </details>
          ))
        )}
      </div>
    </>
  );
}
