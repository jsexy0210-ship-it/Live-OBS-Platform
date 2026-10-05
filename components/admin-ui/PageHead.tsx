// 페이지 머리: 제목(20px) + 오른쪽 주요 버튼. 큰 설명문은 두지 않는다.
// 경로(대분류 › 메뉴)는 셸의 상단 경로 줄(.loc-bar)에서 한 번만 보인다(2026-10-05 시각 규격 「경로는 한 곳에서만」).
// path는 예전 호출과 맞추려고 받기만 하고 화면에 그리지 않는다.
// 사용법:
//   <PageHead title="상품 목록" actions={<Link className="btn" href="/seller/products/new">상품 등록</Link>} />
// 스타일: styles/seller.css 「관리자 공통 컴포넌트」(.au-ph)
export function PageHead({ title, actions }: { title: React.ReactNode; path?: string[]; actions?: React.ReactNode }) {
  return (
    <div className="au-ph">
      <h1 className="au-ph-title">{title}</h1>
      {actions && <div className="au-ph-act">{actions}</div>}
    </div>
  );
}
