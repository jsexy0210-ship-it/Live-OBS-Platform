// 내 정보 메뉴 그룹(허브 /me와 같이 쓴다). 쇼핑·혜택·활동·내 정보 순.
export function myGroups(base: string) {
  return [
    { title: "쇼핑", links: [{ href: `${base}/orders`, label: "주문 내역" }, { href: `${base}/me/addresses`, label: "배송지 관리" }, { href: `${base}/wishlist`, label: "찜" }] },
    { title: "혜택", links: [{ href: `${base}/coupons`, label: "내 쿠폰함" }] },
    { title: "활동", links: [{ href: `${base}/reviews`, label: "내 리뷰" }] },
    { title: "내 정보", links: [{ href: `${base}/me/notifications`, label: "알림 설정" }] },
  ];
}
