import type { ProductReviewPublishMode, ProductReviewReason } from "@prisma/client";
import { cleanText } from "../text/clean";

// 상품 리뷰 입력 검사(DB 없음). 값 범위는 마이그레이션 20261004200000_product_reviews의 CHECK와 같다.
export const REVIEW_BODY_MIN = 10;
export const REVIEW_BODY_MAX = 1000;
export const REVIEW_REPLY_MAX = 300;
export const REVIEW_HIDDEN_NOTE_MAX = 200;
export const REVIEW_EDIT_DAYS = 7;
export const REVIEW_REPORT_HOLD = 3;
export const REVIEW_REWARD_MAX = 100_000;
export const REVIEW_WRITABLE_DAYS_MAX = 365;
export const BANNED_WORDS_MAX = 50;
export const BANNED_WORD_MAX_LEN = 20;
export const REASONS: readonly ProductReviewReason[] = ["PRIVACY", "OFF_TOPIC", "ABUSE", "AD", "OTHER"];
// 파트너스 관리자 화면 이름(숨김·신고 사유)
export const REASON_LABEL: Record<ProductReviewReason, string> = {
  PRIVACY: "개인정보 · 연락처 포함",
  OFF_TOPIC: "상품과 무관한 내용",
  ABUSE: "욕설 · 비방",
  AD: "광고 · 외부 주소",
  OTHER: "기타",
};
// 구매자에게 보이는 숨김 사유(해요체)
export const REASON_BUYER: Record<ProductReviewReason, string> = {
  PRIVACY: "연락처나 개인정보가 들어 있어요",
  OFF_TOPIC: "상품과 관계없는 내용이에요",
  ABUSE: "욕설이나 비방이 들어 있어요",
  AD: "광고나 외부 주소가 들어 있어요",
  OTHER: "판매자가 운영 기준에 맞지 않는다고 판단했어요",
};

export const isReason = (v: unknown): v is ProductReviewReason => typeof v === "string" && (REASONS as readonly string[]).includes(v);

export type ReviewInput = { rating: number; body: string; imageIds: string[] };
export type ReviewRejection = "invalid_rating" | "invalid_body" | "invalid_images";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function parseReview(raw: unknown, maxImages: number): { ok: true; v: ReviewInput } | { ok: false; reason: ReviewRejection } {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rating = b.rating;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, reason: "invalid_rating" };
  const body = cleanText(b.body, REVIEW_BODY_MAX, "multiline");
  if (!body || [...body].length < REVIEW_BODY_MIN) return { ok: false, reason: "invalid_body" };
  const ids = b.imageIds === undefined || b.imageIds === null ? [] : b.imageIds;
  if (!Array.isArray(ids) || ids.length > maxImages || !ids.every(isUuid) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid_images" };
  return { ok: true, v: { rating, body, imageIds: ids } };
}

export const cleanReply = (v: unknown) => cleanText(v, REVIEW_REPLY_MAX, "multiline");

export type PolicyInput = { publishMode: ProductReviewPublishMode; rewardText: number; rewardPhoto: number; writableDays: number; bannedWords: string[] };
const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

export function parsePolicy(raw: unknown): { ok: true; v: PolicyInput } | { ok: false; reason: "invalid_policy" } {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const publishMode = b.publishMode === "IMMEDIATE" || b.publishMode === "REVIEW" ? b.publishMode : null;
  const rewardText = int(b.rewardText, 0, REVIEW_REWARD_MAX);
  const rewardPhoto = int(b.rewardPhoto, 0, REVIEW_REWARD_MAX);
  const writableDays = int(b.writableDays, 1, REVIEW_WRITABLE_DAYS_MAX);
  const words = Array.isArray(b.bannedWords) ? b.bannedWords : null;
  if (!publishMode || rewardText === null || rewardPhoto === null || writableDays === null || !words || words.length > BANNED_WORDS_MAX) return { ok: false, reason: "invalid_policy" };
  const bannedWords: string[] = [];
  for (const w of words) {
    const c = cleanText(w, BANNED_WORD_MAX_LEN);
    if (!c) return { ok: false, reason: "invalid_policy" };
    if (!bannedWords.includes(c)) bannedWords.push(c);
  }
  return { ok: true, v: { publishMode, rewardText, rewardPhoto, writableDays, bannedWords } };
}

// 자동 보류 검사: 연락처(휴대폰·일반 전화·카카오 아이디 안내)·외부 주소와 판매자 금지어. 걸린 이유를 돌려준다(없으면 null).
const PHONE = /(?:0\d{1,2})[\s.-]?\d{3,4}[\s.-]?\d{4}/;
const URL = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|kr|co\.kr|io|me|ly|gg|shop|store)\b|open\.kakao)/i;
const KAKAO_ID = /(카톡|카카오톡|오픈채팅|텔레그램|라인)\s*(아이디|id)?\s*[:：]?\s*[a-z0-9_.-]{3,}/i;

export function heldReason(text: string, bannedWords: string[]): string | null {
  const t = text.normalize("NFKC");
  if (PHONE.test(t) || KAKAO_ID.test(t)) return "contact";
  if (URL.test(t)) return "url";
  const lower = t.toLowerCase();
  const word = bannedWords.find((w) => w && lower.includes(w.toLowerCase()));
  return word ? `banned_word` : null;
}

// 보류 이유 화면 문구(파트너스)
export const HELD_LABEL: Record<string, string> = {
  contact: "연락처 패턴 감지 · 자동 보류",
  url: "외부 주소 감지 · 자동 보류",
  banned_word: "금지어 포함 · 자동 보류",
  reports: "구매자 신고 누적 · 자동 보류",
};

// 리뷰 적립금: 사진 1장 이상이면 사진 리뷰 금액, 아니면 글 리뷰 금액
export const rewardFor = (p: { rewardText: number; rewardPhoto: number }, photos: number) => (photos > 0 ? p.rewardPhoto : p.rewardText);

export const DEFAULT_POLICY: PolicyInput = { publishMode: "IMMEDIATE", rewardText: 0, rewardPhoto: 0, writableDays: 30, bannedWords: [] };
