import { NextResponse } from "next/server";
import { GRADE_MESSAGES } from "./service";

// 회원 등급 API 공통 거부 응답(합니다체 안내 문구 포함)
export function gradeError(reason: string) {
  const status = reason === "not_found" ? 404 : reason === "grade_in_use" || reason === "base_grade_fixed" || reason === "member_not_active" || reason === "duplicate_name" ? 409 : 400;
  return NextResponse.json({ error: reason, message: GRADE_MESSAGES[reason] }, { status });
}
