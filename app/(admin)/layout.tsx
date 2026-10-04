import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/seller.css";
import "./admin.css";
import { brandingMetadata } from "../../lib/server/branding/metadata";

// 마스터 관리자 화면 공통: 파트너스 관리자와 같은 시안 토큰·컴포넌트 스타일을 쓴다(새 디자인 체계를 만들지 않음).
// 파비콘·공유 카드는 「사이트 설정 > 파비콘·공유 카드」에서 정한 값.
export const generateMetadata = () => brandingMetadata("admin");

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app seller-app admin-app" data-theme="light">
      {children}
    </div>
  );
}
