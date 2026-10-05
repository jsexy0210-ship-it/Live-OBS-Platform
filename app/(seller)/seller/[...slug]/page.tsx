import { notFound } from "next/navigation";

// /seller 아래 없는 주소는 파트너스 관리자 404(합니다체)로 받는다. 실제 화면 주소가 먼저 맞으므로 이 줄은 나머지만 받는다.
export default function SellerUnknown() {
  notFound();
}
