import { redirect } from "next/navigation";

// 판매자 홈(SA-002)을 만들기 전까지는 상품 목록으로 보낸다
export default function SellerIndex() {
  redirect("/seller/products");
}
