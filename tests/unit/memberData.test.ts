import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MEMBER_DATA_POLICY } from "../../lib/server/buyers/memberData";

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
      ["BuyerAddress", "BuyerMember", "BuyerPurchaseRestriction", "BuyerSession", "HitCard", "Order", "RewardBalance", "RewardLedger"].sort(),
    );
  });
});
