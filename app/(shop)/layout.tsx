import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/shop.css";

// 구매자 화면 공통 틀(최소): 시안 토큰(.app)과 서체만 입힌다. 쇼핑몰 머리·바닥은 화면마다 ShopFrame으로 감싼다.
export default function ShopRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Gothic+A1:wght@400;500;700;800;900&family=Noto+Sans+KR:wght@400;500;700&display=swap"
        precedence="default"
      />
      <div className="app shop-app" data-theme="light">
        {children}
      </div>
    </>
  );
}
