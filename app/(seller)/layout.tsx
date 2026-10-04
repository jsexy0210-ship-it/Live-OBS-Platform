import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/seller.css";
import { brandingMetadata } from "../../lib/server/branding/metadata";

// 파트너스 관리자 화면 파비콘·공유 카드: 마스터 관리자가 「사이트 설정 > 파비콘·공유 카드」에서 정한 값(플랫폼 공통 1벌)
export const generateMetadata = () => brandingMetadata("seller");

// 판매자 화면 공통: 시안 토큰(.app)과 서체를 입힌다.
export default function SellerRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="app seller-app" data-theme="light">
        {children}
      </div>
    </>
  );
}
