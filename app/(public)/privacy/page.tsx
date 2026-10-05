import type { Metadata } from "next";
import { PublicFrame } from "../../../components/public/PublicFrame";

// PF-009 개인정보처리방침: 법률 검토를 출시 뒤로 미뤄 문구를 게시하지 않고 안내 화면만 둔다(MASTER 결정 2026-10-05).
export const metadata: Metadata = { title: "개인정보처리방침 · ONQ", description: "개인정보처리방침은 정해지는 대로 알려 드려요." };

export default function PrivacyPage() {
  return (
    <PublicFrame>
      <section className="pf-sec pf-doc">
        <article className="pf-doc-body">
          <h1 className="t-t1">개인정보처리방침</h1>
          <div className="msg msg-info t-l2" role="note" data-testid="privacy-pending">
            아직 준비 중이에요. 정해지는 대로 이 페이지에서 알려 드려요.
          </div>
        </article>
      </section>
    </PublicFrame>
  );
}
