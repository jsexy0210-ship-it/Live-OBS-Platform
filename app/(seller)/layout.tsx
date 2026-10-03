import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/seller.css";

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
