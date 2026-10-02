import { describe, expect, it } from "vitest";
import { overlayNickname } from "../../lib/server/overlay/state";

describe("오버레이 닉네임 정리", () => {
  it("제어 문자·방향 바꾸기 문자를 지우고 공백을 정리한다", () => {
    expect(overlayNickname("  카드\u202e왕\n\t망고  ")).toBe("카드왕 망고");
  });

  it("20자를 넘으면 자르고 말줄임표를 붙인다", () => {
    expect(overlayNickname("가".repeat(25))).toBe("가".repeat(20) + "…");
    expect(overlayNickname("가".repeat(20))).toBe("가".repeat(20));
  });
});
