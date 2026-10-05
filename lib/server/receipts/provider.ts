import type { PrismaClient, ReceiptKind } from "@prisma/client";
import { openBillingKey } from "../billing/secret";

// 발행 업체(바로빌 등) 연동 인터페이스(SA-024). 업체 계약·요금 확인은 대표님 조치라 구현체는 아직 없고, 키가 없으면 발행은 대기(PENDING)로 남는다.
// 연동이 붙으면 getReceiptProvider가 구현체를 돌려준다. 업체에는 issueId를 멱등 키로 보내야 한다(같은 발행을 두 번 보내도 한 건만 만들어지게).
// 발행 비용은 파트너스 「발송·이용 충전금」 차감(docs/COST_POLICY.md)이며 차감·잔액 부족 보류(ON_HOLD)는 연동과 함께 붙인다.
export type ReceiptProviderInput = {
  issueId: string;
  kind: ReceiptKind;
  amount: number;
  // 소득공제 휴대폰 / 지출증빙·세금계산서 사업자등록번호(숫자)
  identity: string;
  taxInfo: { companyName: string; representative: string; email: string } | null;
  issuer: { businessNumber: string; companyName: string; representative: string };
};
export type ReceiptProviderResult = { ok: true; providerKey: string } | { ok: false; code: string };
export interface ReceiptProvider {
  readonly name: string;
  issue(input: ReceiptProviderInput): Promise<ReceiptProviderResult>;
}

// 업체 키·계약이 없는 지금은 없음
export function getReceiptProvider(): ReceiptProvider | null {
  return null;
}

export type ProcessReceiptFailure = "not_found" | "not_pending" | "provider_not_configured" | "issuer_not_ready" | "claim_lost";

// 대기(PENDING) 발행 한 건을 업체에 보낸다. 업체가 없거나 발행자 정보·인증서가 준비되지 않았으면 아무것도 바꾸지 않는다(대기 유지).
// 시도 횟수를 조건부로 올려 먼저 가져간 쪽만 업체를 부른다(동시 실행이 같은 건을 두 번 보내지 않게). 결과는 발행(ISSUED) 또는 실패(FAILED, 코드 기록).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function processReceiptIssue(db: PrismaClient, issueId: string, provider: ReceiptProvider | null = getReceiptProvider()) {
  if (!UUID.test(issueId)) return { ok: false as const, reason: "not_found" as const };
  const issue = await db.receiptIssue.findUnique({
    where: { id: issueId },
    select: { id: true, sellerId: true, status: true, amount: true, attempts: true, request: { select: { kind: true, identitySealed: true, taxInfo: true, withdrawnAt: true } } },
  });
  if (!issue) return { ok: false as const, reason: "not_found" as const };
  if (issue.status !== "PENDING" || issue.request.withdrawnAt) return { ok: false as const, reason: "not_pending" as const };
  if (!provider) return { ok: false as const, reason: "provider_not_configured" as const };
  const issuer = await db.sellerReceiptIssuer.findUnique({ where: { sellerId: issue.sellerId } });
  if (!issuer || issuer.certStatus !== "REGISTERED") return { ok: false as const, reason: "issuer_not_ready" as const };
  const claimed = await db.receiptIssue.updateMany({ where: { id: issue.id, status: "PENDING", attempts: issue.attempts }, data: { attempts: { increment: 1 } } });
  if (claimed.count !== 1) return { ok: false as const, reason: "claim_lost" as const };
  const result = await provider.issue({
    issueId: issue.id,
    kind: issue.request.kind,
    amount: issue.amount,
    identity: openBillingKey(issue.request.identitySealed, issue.sellerId),
    taxInfo: (issue.request.taxInfo as ReceiptProviderInput["taxInfo"]) ?? null,
    issuer: { businessNumber: issuer.businessNumber, companyName: issuer.companyName, representative: issuer.representative },
  });
  // 철회와 겹쳤으면(대기가 아니게 됨) 결과를 덮어쓰지 않는다
  await db.receiptIssue.updateMany({
    where: { id: issue.id, status: "PENDING" },
    data: result.ok ? { status: "ISSUED", providerKey: result.providerKey, issuedAt: new Date(), failureCode: null } : { status: "FAILED", failureCode: result.code.slice(0, 100) },
  });
  return { ok: true as const, issued: result.ok };
}
