import { Prisma } from "@prisma/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMBER_DATA_POLICY, MEMBER_REFERENCE_POLICY, memberAuditRetention } from "../../lib/server/buyers/memberData";

// 회원과 이어진 표: BuyerMember 관계가 있거나 buyerMemberId 칸이 있는 모델, 그리고 직접 칸이 없어도 회원 정보를 담는 표
// (본인확인 기록 subjectId, 주문대기는 주문을 거쳐 이어짐). 새 표를 만들고 탈퇴 처리 방식을 정하지 않으면 여기서 실패한다.
const INDIRECT = ["IdentityVerification", "QueueItem"];

describe("탈퇴 때 회원 데이터 처리 목록", () => {
  const models = Prisma.dmmf.datamodel.models;
  const linked = models
    // 회원을 가리키는 쪽(외래 키를 가진 관계)만. Seller·MemberGrade의 BuyerMember[] 목록은 반대쪽이라 뺀다.
    .filter((m) => m.name === "BuyerMember" || m.fields.some((f) => (f.type === "BuyerMember" && (f.relationFromFields?.length ?? 0) > 0) || f.name === "buyerMemberId"))
    .map((m) => m.name);

  it("회원과 이어진 모든 표가 삭제·비식별·법정 보관 중 하나로 분류되어 있다", () => {
    const missing = [...linked, ...INDIRECT].filter((name) => !(name in MEMBER_DATA_POLICY));
    expect(missing).toEqual([]);
  });

  it("목록에 없는 모델 이름을 적지 않는다(이름이 바뀌면 함께 고친다)", () => {
    const names = new Set(models.map((m) => m.name));
    expect(Object.keys(MEMBER_DATA_POLICY).filter((n) => !names.has(n))).toEqual([]);
  });

  it("관계로 찾은 표에 Seller·MemberGrade(회원을 가리키는 쪽)는 들어가지 않는다", () => {
    expect(linked).not.toContain("Seller");
    expect(linked.sort()).toEqual(
      ["BuyerAddress", "BuyerCoupon", "BuyerMember", "CartItem", "BuyerPurchaseRestriction", "BuyerSession", "HitCard", "Order", "ProductReview", "ProductReviewImage", "ProductReviewReport", "RewardBalance", "MemberGradeHistory", "MemberGradeOverride", "OrderReceiptRequest", "RefundRequest", "ReturnRequest", "ReturnRequestImage", "RewardExpiryNotice", "RewardLedger", "WishItem", "RestockAlert"].sort(),
    );
  });

  it("행위자·대상 공용 칸(actorId·targetId)을 가진 모든 표가 구매자 행 처리 방식으로 분류되어 있다", () => {
    const shared = models.flatMap((m) => m.fields.filter((f) => f.name === "actorId" || f.name === "targetId").map((f) => `${m.name}.${f.name}`));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.filter((k) => !(k in MEMBER_REFERENCE_POLICY))).toEqual([]);
    expect(Object.keys(MEMBER_REFERENCE_POLICY).filter((k) => !shared.includes(k))).toEqual([]);
  });
});

// 소스에 적힌 감사 로그 행동 이름(action: "…"·audit("…")). 구매자 회원 id를 행위자·대상으로 남길 수 있는 행동(주문·구매자·구매자 인증)만 본다.
function sourceAuditActions(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk("lib/server");
  walk("app/api");
  const found = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/(?:action:\s*(?:[^"\n]*\?\s*)?|audit\()"([a-z_]+(?:\.[a-z_]+)+)"(?:\s*:\s*"([a-z_]+(?:\.[a-z_]+)+)")?/g)) {
      for (const a of [m[1], m[2]]) if (a) found.add(a);
    }
  }
  return [...found].filter((a) => /^(order\.|buyer|auth\.buyer\.)/.test(a)).sort();
}

describe("탈퇴 회원 감사 로그 행동 종류별 보관", () => {
  it("거래 관련(주문·결제·취소·환불·배송)은 5년 보관 분류다", () => {
    for (const a of ["order.create", "order.paid", "order.cancel", "order.auto_cancel", "order.refund", "order.ship", "order.shipment.update", "order.deliver", "order.auto_deliver", "order.purchase_confirmed"]) {
      expect(memberAuditRetention(a), a).toBe("transaction");
    }
  });

  it("거래 무관(로그인·로그인 실패·가입·회원 정보 수정·탈퇴)은 3개월 뒤 비식별 분류다", () => {
    for (const a of ["auth.buyer.login", "auth.buyer.login_failed", "buyer.signup", "buyer_address.create", "buyer_address.update", "buyer_address.delete", "buyer.withdraw", "buyer.withdraw_failed"]) {
      expect(memberAuditRetention(a), a).toBe("non_transaction");
    }
  });

  it("목록에 없는 행동은 분류 없음(null)이다", () => {
    expect(memberAuditRetention("buyer.something_new")).toBeNull();
    expect(memberAuditRetention("product.create")).toBeNull();
  });

  it("소스에 있는 주문·구매자 행동은 모두 분류되어 있다(새 행동을 만들면 MEMBER_AUDIT_RETENTION에 넣는다)", () => {
    const actions = sourceAuditActions();
    expect(actions).toEqual(expect.arrayContaining(["order.create", "order.refund", "auth.buyer.login", "auth.buyer.login_failed", "buyer.signup", "buyer.withdraw"]));
    expect(actions.filter((a) => memberAuditRetention(a) === null)).toEqual([]);
  });
});
