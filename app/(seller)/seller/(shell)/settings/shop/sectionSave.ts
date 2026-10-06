// SA-060 쇼핑몰 정보: 페이지 하나의 「저장」이 구역(내 도메인 · 사업자·고객센터)마다 따로인 서버 API를 차례로 부르도록 구역이 자기 상태를 알리는 약속.
// 구역은 렌더마다 자기 핸들을 넘기고, 페이지는 「바뀐 구역」만 검사·저장한다. 저장이 실패하면 실패 메시지(문자열)를 돌려주고, 성공하면 null이다.
export type SectionHandle = {
  label: string;
  dirty: boolean;
  /** 입력 오류를 화면에 보이고 저장해도 되는지 돌려준다 */
  validate: () => boolean;
  save: () => Promise<string | null>;
  /** 「취소」: 고치던 값을 저장된 값으로 되돌린다 */
  reset: () => void;
};
export type OnSection = (key: string, handle: SectionHandle) => void;
