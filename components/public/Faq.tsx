import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import { FaqList } from "./FaqList";

// PF-004 자주 묻는 질문(디자인 PF-004)
export function Faq() {
  return (
    <PublicFrame active="/faq">
      <section className="pf-sec">
        <h1 className="t-d2">자주 묻는 질문</h1>
        <FaqList />
        <div className="card pf-ask">
          <span className="t-hl2">원하는 답이 없나요?</span>
          <span className="t-l2 c-alt">로그인한 뒤 파트너스 관리자에서 문의해 주세요.</span>
          <Link className="btn btn-out" href="/seller/login">
            로그인
          </Link>
        </div>
      </section>
    </PublicFrame>
  );
}
