import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/seller.css";

// 판매자 화면 공통: 시안 토큰(.app)과 서체를 입힌다.
export default function SellerRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Gothic+A1:wght@400;500;700;800;900&family=Noto+Sans+KR:wght@400;500;700&display=swap"
        precedence="default"
      />
      <div className="app seller-app" data-theme="light">
        {children}
      </div>
    </>
  );
}
