import { PublicFrame } from "../../../components/public/PublicFrame";

// PF-009 정본 로딩 상태: 문안이 준비되는 동안 본문 자리만 표시한다.
export default function PrivacyLoading() {
  return (
    <PublicFrame>
      <section className="pf-sec pf-doc" aria-busy="true" aria-label="개인정보처리방침 불러오는 중">
        <article className="pf-doc-body">
          <div className="col" style={{ width: "100%", gap: 10 }}>
            <span className="sk" style={{ height: 28, width: "40%" }} />
            <span className="sk" style={{ height: 14, width: "90%" }} />
            <span className="sk" style={{ height: 14, width: "75%" }} />
          </div>
        </article>
      </section>
    </PublicFrame>
  );
}
