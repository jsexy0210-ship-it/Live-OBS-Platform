import { NextResponse } from "next/server";
import { errorResponse, mutation, noStore } from "../http/route";

export class EventError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 429, readonly code: string) { super(code); }
}
export function eventErrorResponse(error: unknown) {
  return noStore(error instanceof EventError ? NextResponse.json({ error: error.code }, { status: error.status }) : errorResponse(error));
}
// 공통 mutation의 Origin 검사와 권한 오류 처리를 유지하며 이벤트 검증 오류를 명시 상태로 응답한다.
export function eventMutation<A extends unknown[]>(handler: (req: Request, ...args: A) => Promise<Response>) {
  return mutation(async (req: Request, ...args: A) => {
    try { return await handler(req, ...args); } catch (e) { return eventErrorResponse(e); }
  });
}
