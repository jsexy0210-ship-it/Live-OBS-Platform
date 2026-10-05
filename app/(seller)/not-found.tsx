import { NotFoundView } from "../../components/public/NotFoundView";

// AU-009 파트너스 관리자 404(합니다체)
export default function SellerNotFound() {
  return <NotFoundView tone="admin" href="/seller" />;
}
