import { EventPopupForPage } from "./EventPopup";

// 구매자 화면 머리·바닥(최소). 쇼핑몰 이름만 보여 준다. 쇼핑몰 홈·로그인 화면이 생기면 여기에 링크를 단다.
export default function ShopFrame({ shopName, children }: { shopName: string; children: React.ReactNode }) {
  return (
    <div className="shop-page">
      <header className="shop-top">
        <span className="shop-name">{shopName}</span>
      </header>
      <main className="shop-main">{children}</main>
      <EventPopupForPage />
      <footer className="shop-foot">
        <span className="t-l2 c-alt">
          <span className="logo-word" />로 운영하는 쇼핑몰이에요
        </span>
      </footer>
    </div>
  );
}
