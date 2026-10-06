import { describe, expect, it } from "vitest";
import { BUYER_PASSWORD_MAX, isAcceptableBuyerPassword } from "../../lib/server/buyers/passwordPolicy";

// 구매자 새 비밀번호 기준: 영문과 숫자를 섞어 8자 이상(MASTER 결정 2026-10-06).
describe("구매자 새 비밀번호 기준", () => {
  it("영문+숫자를 섞은 8자 이상만 받는다(기호·한글은 있어도 되지만 영문과 숫자가 둘 다 필요)", () => {
    for (const ok of ["abcdefg1", "ABCDEFG1", "test-password-1", "1a2b3c4d", "한글비밀번호abc1", "a".repeat(7) + "1", "x1" + "!".repeat(6)]) expect(isAcceptableBuyerPassword(ok), ok).toBe(true);
  });
  it("영문만·숫자만·한글+숫자·8자 미만·200자 초과·문자열이 아니면 거부한다", () => {
    for (const bad of ["onlyletters", "12345678", "가나다라마바사아1", "abc123", "a1", "", "!!!!!!!!!!", "a".repeat(BUYER_PASSWORD_MAX) + "1", null, undefined, 12345678, ["abc12345"]]) {
      expect(isAcceptableBuyerPassword(bad as unknown), String(bad)).toBe(false);
    }
    expect(isAcceptableBuyerPassword("a".repeat(BUYER_PASSWORD_MAX - 1) + "1")).toBe(true);
  });
});
