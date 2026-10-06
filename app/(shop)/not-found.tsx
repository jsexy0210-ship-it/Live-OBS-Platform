import ShopState from "../../components/shop/ShopState";

// 구매자 화면 404: 없는 쇼핑몰·운영 중이 아닌 쇼핑몰 주소
export default function ShopNotFound() {
  return (
    <div className="shop-page">
      <main className="shop-main">
        <ShopState title="이런 쇼핑몰은 없어요" body="주소를 다시 확인해 주세요" />
      </main>
    </div>
  );
}
