import { NextResponse } from "next/server";
import { YOUTUBE_MESSAGES, youtubeRejectionStatus, type YoutubeResult } from "./call";

// 유튜브 연결 라우트 응답: 거부는 { error, message }(파트너스 관리자 문구)와 상태 코드.
export function youtubeResponse<T>(r: YoutubeResult<T>): NextResponse {
  if (r.ok) return NextResponse.json(r.value);
  return NextResponse.json({ error: r.reason, message: YOUTUBE_MESSAGES[r.reason] }, { status: youtubeRejectionStatus(r.reason) });
}
