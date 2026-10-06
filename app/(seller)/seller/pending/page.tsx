import Link from "next/link";
import { AuthFrame } from "../../../../components/seller/PartnersAuth";
import PendingApplication from "../../../../components/seller/PendingApplication";

// AU-005 파트너스 가입 승인 대기 안내. 가입 신청을 보낸 뒤 승인 전에 로그인하면(seller_pending) 로그인 화면이 이리로 보낸다. 로그인은 승인 뒤에 열린다.
// 로그인 시도에서 받은 15분 쿠키가 있으면 후속 상태(보완 요청·반려·심사 지연)를 아래에 보인다(PendingApplication).
export default function SellerPendingPage() {
  return (
    <AuthFrame>
      <div className="col" style={{ gap: 14, alignItems: "center", textAlign: "center" }} data-testid="seller-pending">
        <h1 className="t-t3">가입 신청을 확인하고 있습니다</h1>
        <span className="t-l2 c-alt">신청하신 내용을 확인하고 있습니다. 확인이 끝나면 가입한 이메일로 알려 드립니다. 그 전에는 로그인할 수 없습니다.</span>
        <PendingApplication />
        <Link className="btn btn-lg btn-block" href="/seller/login">
          로그인 화면으로
        </Link>
      </div>
    </AuthFrame>
  );
}
