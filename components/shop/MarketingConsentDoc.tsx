// 마케팅 정보 수신 동의 서식(docs/terms/MARKETING_CONSENT_TEMPLATE.md, 버전 lib/server/buyers/consent.ts SIGNUP_CONSENT_VERSIONS.marketing).
// 동의를 받기 전에 이 글 전체를 보여 준다. 서식을 바꾸면 이 글과 버전을 함께 바꾼다.
export default function MarketingConsentDoc({ shopName }: { shopName: string }) {
  return (
    <div className="col mc-doc" style={{ gap: 10 }} data-testid="mc-doc">
      <p className="t-l2" style={{ margin: 0, lineHeight: 1.6 }}>
        {shopName}은(는) 라이브 방송 시작·이벤트·할인·새 상품 소식을 보내기 위해 아래와 같이 개인정보를 이용해요.
      </p>
      <table className="mc-table">
        <thead>
          <tr>
            <th scope="col">이용 목적</th>
            <th scope="col">이용 항목</th>
            <th scope="col">보유·이용 기간</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>라이브 방송 시작 알림, 이벤트·할인·새 상품 등 광고성 정보 안내(카카오톡 광고 메시지·문자)</td>
            <td>이름, 휴대폰 번호</td>
            <td>동의를 철회하거나 회원 탈퇴할 때까지</td>
          </tr>
        </tbody>
      </table>
      <p className="t-l2 c-alt" style={{ margin: 0, lineHeight: 1.6 }}>
        동의하지 않아도 가입과 주문은 그대로 할 수 있어요. 동의하지 않으면 방송 시작 알림과 이벤트·할인·새 상품 소식만 받지 않아요. 동의는 회원 정보에서 언제든 철회할 수 있어요.
      </p>
    </div>
  );
}
