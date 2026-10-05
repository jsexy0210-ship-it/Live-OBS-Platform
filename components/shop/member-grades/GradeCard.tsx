import type { buyerGradeStatus } from "../../../lib/server/shop-member-grades/benefits";
import "./grade-card.css";

// 내 정보(SH-020) 위쪽 등급 카드: 지금 등급, 혜택, 다음 등급까지 남은 금액(자동 등급이 켜져 있을 때만). 구매자 화면이라 해요체.
type Status = NonNullable<Awaited<ReturnType<typeof buyerGradeStatus>>>;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export default function GradeCard({ status }: { status: Status }) {
  const range = status.windowMonths === 0 ? "지금까지" : `최근 ${status.windowMonths}개월`;
  return (
    <div className="mgc" data-testid="grade-card">
      <p className="mgc-t">
        내 등급 <b>{status.gradeName}</b>
      </p>
      {status.benefits.length > 0 && <p className="mgc-s">{status.benefits.join(" · ")} 혜택을 받고 있어요</p>}
      {status.nextGrade ? (
        <p className="mgc-s">
          {range} 결제 {won(status.amount)} · <b>{won(status.nextGrade.remaining)}</b> 더 쓰면 <b>{status.nextGrade.name}</b> 등급이 돼요
        </p>
      ) : null}
    </div>
  );
}
