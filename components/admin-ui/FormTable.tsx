// 등록·수정용 2열 표형 폼: 섹션 제목 + (왼쪽 회색 항목명 칸 | 오른쪽 입력 칸) 줄들, 하단 가운데 저장 버튼.
// 사용법:
//   <form onSubmit={save}>
//     <FormSection title="기본 정보">
//       <FormRow label="상품명" required htmlFor="name" help="100자까지"><input id="name" className="inp" … /></FormRow>
//       <FormRow label="판매 상태"><label className="chk"><input className="rdo" type="radio" … />판매 중</label></FormRow>
//     </FormSection>
//     <FormFoot><button className="btn btn-lg" type="submit">저장</button></FormFoot>
//   </form>
// 스타일: styles/seller.css (.au-fs · .au-ft · .au-ff)
export function FormSection({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="au-fs">
      <div className="au-fs-h">
        <h2 className="au-fs-t">{title}</h2>
        {actions}
      </div>
      <table className="au-ft">
        <tbody>{children}</tbody>
      </table>
    </section>
  );
}

export function FormRow({
  label,
  required,
  htmlFor,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <th scope="row">{htmlFor ? <label htmlFor={htmlFor} className={required ? "req" : undefined}>{label}</label> : <span className={required ? "req" : undefined}>{label}</span>}</th>
      <td>
        <div className="au-ft-v">{children}</div>
        {help && <p className="help au-ft-help">{help}</p>}
      </td>
    </tr>
  );
}

// 하단 가운데 저장 버튼 줄(화면 아래에 붙어 있다)
export function FormFoot({ children }: { children: React.ReactNode }) {
  return <div className="au-ff">{children}</div>;
}
