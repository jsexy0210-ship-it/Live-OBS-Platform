import { NextResponse } from "next/server";
import { BUYER_RETURN_MESSAGES, SELLER_RETURN_MESSAGES } from "./service";

// 교환·반품 API 공통 응답. 거부 사유는 상태 코드와 화면 안내 문구(구매자 해요체 / 파트너스 합니다체)로 바꾼다.
export function returnStatus(reason: string): number {
  if (reason === "not_found") return 404;
  if (reason === "shop_unavailable") return 402;
  if (reason.startsWith("invalid_") && reason !== "invalid_transition") return 400;
  if (["empty_file", "unsupported_image", "wrong_image_size", "png_16bit", "png_too_large", "fault_required", "refund_account_required", "file_too_large"].includes(reason)) return reason === "file_too_large" ? 413 : 400;
  return 409;
}

export function returnError(reason: string, who: "buyer" | "seller") {
  const messages = who === "buyer" ? BUYER_RETURN_MESSAGES : SELLER_RETURN_MESSAGES;
  return NextResponse.json({ error: reason, message: messages[reason] }, { status: returnStatus(reason) });
}
