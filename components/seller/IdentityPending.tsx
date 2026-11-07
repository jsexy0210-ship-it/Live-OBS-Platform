// 본인확인 대기 안내(정본 SA-100 · SA-034 · SA-081 상태 변형, 문구는 AU-013과 같음).
// 마스터 최고관리자가 직접 추가했고 대표자 본인확인이 끝나지 않은 쇼핑몰은 직원 추가 · 적립금 실제 지급 켜기 · 충전금 결제가 막힌다.
// 세션이 미리 알면(me.identityPending) 처음부터 잠그고, 모르면 눌렀을 때 서버 403 identity_pending으로 같은 안내를 보인다.
export const IDENTITY_PENDING_CODE = "identity_pending";

export const isIdentityPendingFail = (r: { status: number; error?: string }) => r.status === 403 && r.error === IDENTITY_PENDING_CODE;

// feature: 막힌 기능 이름(예: 직원 추가). 「~는 본인확인을 마치면 쓸 수 있습니다」에 이어 붙는다(받침 없는 이름만 쓴다)
export const identityPendingText = (feature: string) =>
  `${feature}는 본인확인을 마치면 쓸 수 있습니다 · 아이디 · 비밀번호 찾기는 쓸 수 없고 마스터 관리자가 초대 링크를 다시 발급해 드립니다`;

export const IDENTITY_PENDING_TITLE = "대표자 본인확인이 아직 끝나지 않았습니다.";

export function IdentityPendingNotice({ feature, style }: { feature: string; style?: React.CSSProperties }) {
  return (
    <div className="msg msg-cau" role="note" data-testid="identity-pending" style={style}>
      <span>
        <b>{IDENTITY_PENDING_TITLE}</b> {identityPendingText(feature)}
      </span>
    </div>
  );
}
