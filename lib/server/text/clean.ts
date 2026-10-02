// 사용자가 입력한 글자 정리(배송지·상품 공통). NFKC로 정규화한 뒤 아래를 거부하고, 앞뒤 공백을 자른 값을 돌려준다.
// - 제어(Cc)·서식(Cf: 방향 바꿈·폭 없는 공백 등)·짝 없는 서로게이트(Cs)·사용자 정의(Co)·미할당(Cn)·줄·문단 구분(Zl·Zp) 문자
//   (DB 오류·송장 출력 깨짐·표시 위장 방지). 전각 공백·NBSP는 정규화에서 일반 공백이 되어 허용된다.
// - 이름(name): 빈칸처럼 보이는 한글 채움 문자·점자 빈칸, 눈에 보이는 글자(문자·숫자·기호·문장부호)가 하나도 없는 값(결합 문자만 등)
// - 메모(memo): 이모지를 쓰도록 ZWJ·변형 선택자는 허용하고, 태그 문자는 깃발 시퀀스(🏴 + 태그 + 끝 태그) 안에서만 허용한다.
//   비문자(U+FDD0–FDEF, 각 평면의 xFFFE·xFFFF)는 거부한다. 서버가 아직 모르는 최신 이모지가
//   미할당(Cn)으로 판정돼 주문이 막히지 않게 Cn 검사는 하지 않는다(Cs·Co·제어·서식(방향 문자 등)은 그대로 거부)
// - 여러 줄(multiline): 줄바꿈(\n)만 허용
// 보이지 않는 문자는 소스에 그대로 넣지 않고 \u 이스케이프로만 쓴다.
const DISALLOWED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const DISALLOWED_MEMO = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const BLANK_LOOKALIKE = /[\u115f\u1160\u3164\uffa0\u2800]/u;
const EMOJI_JOINERS = /[\u200d\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
// 지역 깃발: 검은 깃발(U+1F3F4) + 태그 글자(U+E0020–E007E) 1개 이상 + 끝 태그(U+E007F). 이 밖의 태그 문자는 서식 문자(Cf)로 거부된다.
const TAG_FLAG = /\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}/gu;
// 비문자: U+FDD0–FDEF와 각 평면의 끝 두 글자(xFFFE·xFFFF). 메모는 Cn 검사를 하지 않으므로 따로 거부한다.
const NONCHARACTER = /[\ufdd0-\ufdef\ufffe\uffff\u{1fffe}\u{1ffff}\u{2fffe}\u{2ffff}\u{3fffe}\u{3ffff}\u{4fffe}\u{4ffff}\u{5fffe}\u{5ffff}\u{6fffe}\u{6ffff}\u{7fffe}\u{7ffff}\u{8fffe}\u{8ffff}\u{9fffe}\u{9ffff}\u{afffe}\u{affff}\u{bfffe}\u{bffff}\u{cfffe}\u{cffff}\u{dfffe}\u{dffff}\u{efffe}\u{effff}\u{ffffe}\u{fffff}\u{10fffe}\u{10ffff}]/u;
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;
const VISIBLE_MEMO = /[\p{L}\p{N}\p{S}\p{P}\p{Cn}]/u;

export type TextKind = "name" | "memo" | "multiline";

export function cleanText(v: unknown, max: number, kind: TextKind = "name"): string | null {
  if (typeof v !== "string") return null;
  const n = v.normalize("NFKC");
  const checked = kind === "memo" ? n.replace(TAG_FLAG, "").replace(EMOJI_JOINERS, "") : kind === "multiline" ? n.replace(/\r?\n/g, "") : n;
  if ((kind === "memo" ? DISALLOWED_MEMO : DISALLOWED).test(checked) || NONCHARACTER.test(checked)) return null;
  if (kind === "name" && (BLANK_LOOKALIKE.test(v) || BLANK_LOOKALIKE.test(n))) return null;
  const t = (kind === "multiline" ? n.replace(/\r\n/g, "\n") : n).trim();
  if (t.length === 0 || t.length > max || !(kind === "memo" ? VISIBLE_MEMO : VISIBLE).test(t)) return null;
  return t;
}
