import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { addBlockedTerm, BLOCKED_TERM_MESSAGES, listBlockedTerms, removeBlockedTerm, type BlockedTermFailure } from "../../../../../lib/server/shop-search/service";

const status = (r: BlockedTermFailure) => (r === "term_not_found" ? 404 : 400);

// 인기 검색어에서 뺄 단어 목록 { terms: [{ term, createdAt }], canEdit }. 같은 쇼핑몰 파트너스 계정 누구나 조회.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listBlockedTerms(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

// 단어 추가. 본문 { term }(2~20자, 소문자·공백 정리 뒤 저장, 최대 100개). 이미 있으면 그대로 200. 이 단어가 들어 있는 검색어가 인기 검색어에서 빠진다. 대표자·PRODUCT_MANAGE 직원만.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await addBlockedTerm(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: BLOCKED_TERM_MESSAGES[r.reason] }, { status: status(r.reason) });
  return NextResponse.json({ term: r.term }, { status: 201 });
});

// 단어 삭제. ?term=단어. 등록되지 않은 단어는 404.
export const DELETE = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await removeBlockedTerm(prisma, ctx, new URL(req.url).searchParams.get("term"), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: BLOCKED_TERM_MESSAGES[r.reason] }, { status: status(r.reason) });
  return NextResponse.json({ ok: true });
});
