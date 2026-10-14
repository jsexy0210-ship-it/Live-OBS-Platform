"use client";

export default function MyPageError() {
  return <section className="card shop-card col shop-my"><h1 className="t-h1">내 정보</h1><p>정보를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.</p><button className="btn" type="button" onClick={() => window.location.reload()}>다시 시도</button></section>;
}
