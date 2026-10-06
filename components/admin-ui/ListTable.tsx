// 목록 표 부품: 위쪽 「총 n건」+ 일괄 처리 버튼 영역, 표는 기존 .tbl, 아래 번호형 페이지 이동.
// 검색/필터 → ListHead(건수 왼쪽·작업 오른쪽) → ListTable(표만 테두리) → 페이지 이동/안내.
// 외곽은 .au-list-section처럼 테두리 없이 두며, 검색·건수·작업·페이지 안내를 grid 프레임 안에 넣지 않는다.
//   <section className="au-list-section">
//     <ListHead total={total} loaded actions={<button className="btn btn-out" …>선택 삭제</button>} />
//     <ListTable aria-label="주문 목록 표"><table className="tbl">…</table></ListTable>
//     <Pagination page={page} pageCount={pageCount} onChange={setPage} />
//   </section>
// 스타일: styles/seller.css (.au-lh · .au-lt-wrap · .au-list-section · .pg)
// loaded: 전체 수를 주는 API가 없어 지금 불러온 행 수만 아는 경우. 「총」 대신 「불러온」으로 보여 전체 건수처럼 읽히지 않게 한다.
export function ListHead({ total, unit = "건", loaded = false, actions }: { total: number; unit?: string; loaded?: boolean; actions?: React.ReactNode }) {
  return (
    <div className="au-lh">
      <span className="au-lh-total" aria-live="polite">
        {loaded ? "불러온" : "총"} <b className="num">{total.toLocaleString("ko-KR")}</b>
        {unit}
      </span>
      {actions && <div className="au-lh-act">{actions}</div>}
    </div>
  );
}

// 데이터 표의 외곽 프레임만 제공한다. 검색/건수/작업/페이지 이동은 이 부품 밖에 둔다.
// className은 화면별 grid 폭/카드 변환에 사용하며 기존 .tbl와 버튼 토큰을 그대로 쓴다.
export function ListTable({ children, className, "aria-label": label = "목록 표" }: { children: React.ReactNode; className?: string; "aria-label"?: string }) {
  return <div className={`au-lt-wrap au-list-grid${className ? ` ${className}` : ""}`} role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

// page는 1부터. 한 번에 10개 번호를 보이고, 처음·이전·다음·마지막 버튼을 둔다.
export function Pagination({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  if (pageCount <= 1) return null;
  const start = Math.floor((page - 1) / 10) * 10 + 1;
  const end = Math.min(pageCount, start + 9);
  const nums: number[] = [];
  for (let n = start; n <= end; n++) nums.push(n);
  const go = (n: number) => () => onChange(Math.min(pageCount, Math.max(1, n)));
  return (
    <nav className="pg au-pg" aria-label="페이지 이동">
      <button type="button" onClick={go(1)} disabled={page === 1} aria-label="처음">
        «
      </button>
      <button type="button" onClick={go(page - 1)} disabled={page === 1} aria-label="이전">
        ‹
      </button>
      {nums.map((n) => (
        <button key={n} type="button" className={n === page ? "on" : undefined} aria-current={n === page ? "page" : undefined} onClick={go(n)}>
          {n}
        </button>
      ))}
      <button type="button" onClick={go(page + 1)} disabled={page === pageCount} aria-label="다음">
        ›
      </button>
      <button type="button" onClick={go(pageCount)} disabled={page === pageCount} aria-label="마지막">
        »
      </button>
    </nav>
  );
}
