import { cleanText } from "../text/clean";

// 직원 이름 최대 글자 수(코드포인트). 만들기·고치기(sellers/staff.ts), 본인확인 연결의 시작·확인 결과 정리·비교
// (sellers/staffIdentity.ts, identity/verification.ts)가 모두 이 값을 쓴다.
export const STAFF_NAME_MAX = 50;
// 직원 이름 정규화: NFKC·앞뒤 공백 정리, 제어·서식 문자(폭 없는 공백 등)·빈칸처럼 보이는 글자 거부, 코드포인트 50자까지.
// 저장하는 값과 연결 비교가 같은 기준이라, 저장한 이름은 본인확인 결과와 항상 같은 방식으로 비교된다. 맞지 않으면 null.
export const cleanStaffName = (v: unknown): string | null => cleanText(v, STAFF_NAME_MAX);
