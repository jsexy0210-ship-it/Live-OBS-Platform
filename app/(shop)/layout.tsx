import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/shop.css";

// 구매자 화면 공통 틀(최소): 시안 토큰(.app)과 서체만 입힌다. 쇼핑몰 머리·바닥은 [slug]/layout.tsx가 ShopFrame으로 한 번만 그린다.
export default function ShopRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="app shop-app" data-theme="light">
        {children}
      </div>
    </>
  );
}
