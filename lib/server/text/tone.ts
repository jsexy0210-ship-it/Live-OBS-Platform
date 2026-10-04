// 서버 응답 문구(message)의 말투(대표님 지시 2026-10-04, CLAUDE.md 「화면 문구」).
// formal: 파트너스·마스터 관리자 API(`app/api/seller/**`, `app/api/admin/**`)는 합니다체, 요청은 「~해 주십시오」.
// friendly: 구매자 쇼핑몰·공개·오버레이 API와 파트너스 가입 신청(PF)은 해요체.
// 화면은 error 코드로 분기하고 message는 그대로 보여 준다. 같은 사유를 두 쪽이 쓰면 문구표를 말투별로 둔다.
export type MessageTone = "formal" | "friendly";
