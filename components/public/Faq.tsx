import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import { FaqList } from "./FaqList";

// PF-004 자주 묻는 질문(디자인 PF-004)
export function Faq() {
  return (
    <PublicFrame active="/faq">
      <section className="pf-sec pf-info-section">
        <h1 className="t-d2">자주 묻는 질문</h1>
        <FaqList />
        <div className="card row between pf-ask">
          <span className="col" style={{ gap: 2 }}>
            <span className="t-hl2">원하는 답이 없나요?</span>
            <span className="t-l2 c-alt">운영팀이 평일 10~18시에 답해요. 평균 첫 답변 4시간.</span>
          </span>
          <Link className="btn" href="/seller/login?next=%2Fseller%2Finquiries%2Fnew">
            문의하기
          </Link>
        </div>
      </section>
    </PublicFrame>
  );
}
