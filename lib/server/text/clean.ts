// 사용자가 입력한 글자 정리(배송지·상품 공통). NFKC로 정규화한 뒤 아래를 거부하고, 앞뒤 공백을 자른 값을 돌려준다.
// - 제어(Cc)·서식(Cf: 방향 바꿈·폭 없는 공백 등)·짝 없는 서로게이트(Cs)·사용자 정의(Co)·미할당(Cn)·줄·문단 구분(Zl·Zp) 문자
//   (DB 오류·송장 출력 깨짐·표시 위장 방지). 전각 공백·NBSP는 정규화에서 일반 공백이 되어 허용된다.
// - 이름(name): 빈칸처럼 보이는 한글 채움 문자·점자 빈칸, 눈에 보이는 글자(문자·숫자·기호·문장부호)가 하나도 없는 값(결합 문자만 등)
// - 메모(memo): 이모지를 쓰도록 ZWJ·변형 선택자는 허용
// - 여러 줄(multiline): 줄바꿈(\n)만 허용
const DISALLOWED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const BLANK_LOOKALIKE = /[ᅟᅠㅤﾠ⠀]/u;
const EMOJI_JOINERS = /[‍︀-️\u{e0100}-\u{e01ef}]/gu;
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

export type TextKind = "name" | "memo" | "multiline";

export function cleanText(v: unknown, max: number, kind: TextKind = "name"): string | null {
  if (typeof v !== "string") return null;
  const n = v.normalize("NFKC");
  const checked = kind === "memo" ? n.replace(EMOJI_JOINERS, "") : kind === "multiline" ? n.replace(/\r?\n/g, "") : n;
  if (DISALLOWED.test(checked)) return null;
  if (kind === "name" && (BLANK_LOOKALIKE.test(v) || BLANK_LOOKALIKE.test(n))) return null;
  const t = (kind === "multiline" ? n.replace(/\r\n/g, "\n") : n).trim();
  if (t.length === 0 || t.length > max || !VISIBLE.test(t)) return null;
  return t;
}
