// 표형 검색 상자: 왼쪽 회색 항목명 칸 + 입력 칸을 한 줄씩 쌓고, 아래 가운데 「검색」「초기화」 버튼.
// 사용법:
//   <SearchBox onSearch={() => load()} onReset={() => setQ(initial)}>
//     <SearchRow label="기간"><input className="inp" type="date" … /> ~ <input className="inp" type="date" … /></SearchRow>
//     <SearchRow label="검색어"><input className="inp" value={q} onChange={…} /></SearchRow>
//   </SearchBox>
// 정본(DS-PANEL · SA-011/SA-021/MA-011 FINAL)은 한 줄에 항목 두 쌍(항목명 | 값 | 항목명 | 값)을 둔다: 두 번째 쌍은 label2·children2로 넣는다.
//   <SearchRow label="판매 상태" label2="노출 상태" children2={<노출 라디오 … />}><판매 라디오 … /></SearchRow>
// 기간처럼 넓은 항목은 쌍 없이 한 줄 전체(기본). 휴대폰 폭(768 미만)에서는 모두 한 열로 쌓인다.
// Enter로도 검색된다(form 제출). 「검색」「초기화」는 같은 레벨이라 같은 높이(40)·같은 폭(80). 스타일: styles/seller.css (.au-sb)
export function SearchBox({
  onSearch,
  onReset,
  busy,
  label = "검색 조건",
  children,
}: {
  onSearch: () => void;
  onReset?: () => void;
  busy?: boolean;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <form
      className="au-sb"
      role="search"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
    >
      <table className="au-ft">
        <colgroup>
          <col style={{ width: 160 }} />
          <col />
          <col style={{ width: 160 }} />
          <col />
        </colgroup>
        <tbody>{children}</tbody>
      </table>
      <div className="au-sb-f">
        <button className="btn btn-dense btn-w-sm" type="submit" disabled={busy}>
          검색
        </button>
        {onReset && (
          <button className="btn btn-dense btn-out btn-w-sm" type="button" onClick={onReset} disabled={busy}>
            초기화
          </button>
        )}
      </div>
    </form>
  );
}

export function SearchRow({ label, children, label2, children2 }: { label: string; children: React.ReactNode; label2?: string; children2?: React.ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td colSpan={label2 ? 1 : 3}>
        <div className="au-ft-v">{children}</div>
      </td>
      {label2 && (
        <>
          <th scope="row">{label2}</th>
          <td>
            <div className="au-ft-v">{children2}</div>
          </td>
        </>
      )}
    </tr>
  );
}
