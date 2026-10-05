import { NextResponse } from "next/server";
import { MESSAGE_MESSAGES } from "./service";

// 회원 대상 발송 API 공통 거부 응답(합니다체 안내 문구 포함). extra는 거부와 함께 알려 줄 값(광고성 시간 밖일 때 바꿀 시각 등).
export function messageError(reason: string, extra: Record<string, unknown> = {}) {
  const status = reason === "not_found" ? 404 : reason === "invalid_transition" || reason === "no_recipients" ? 409 : 400;
  return NextResponse.json({ error: reason, message: MESSAGE_MESSAGES[reason], ...extra }, { status });
}
