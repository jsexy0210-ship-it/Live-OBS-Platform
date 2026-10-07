import { describe, expect, it } from "vitest";
import { MAINTENANCE_COPY, maintenanceTone, PARTNERS_AREA } from "../../components/public/maintenanceCopy";

// AU-010 점검 중 화면 문구: 파트너스 관리자는 합니다체·「~해 주십시오」, 공개·구매자 쇼핑몰은 해요체(CLAUDE.md 「화면 문구」).
const TIME = "10월 6일 04:00";
const strings = (t: keyof typeof MAINTENANCE_COPY) => {
  const c = MAINTENANCE_COPY[t];
  return [c.title, c.fallback, c.ends(TIME), c.note, c.doneTitle, c.doneBody, c.doneCta];
};

describe("점검 중 화면 문구 말투", () => {
  it("관리자 말투는 해요체 문장이 없고, 해요체는 합니다체 문장이 없다", () => {
    for (const m of strings("formal")) expect(m, m).not.toMatch(/(요|요\.|요\?)$/);
    for (const m of strings("friendly")) expect(m, m).not.toMatch(/(니다|십시오)/);
  });

  it("구역 값: partners·admin일 때 관리자 말투, 그 밖의 값·없음·여러 값은 해요체", () => {
    expect(maintenanceTone(PARTNERS_AREA)).toBe("formal");
    expect(maintenanceTone("admin")).toBe("formal");
    for (const v of [undefined, "", "PARTNERS", "partners ", ["partners"], ["partners", "x"]]) expect(maintenanceTone(v), String(v)).toBe("friendly");
  });

  it("관리자 말투에 점검 뒤 확인할 주문 정보를 안내하고 시각 문구가 끝에 붙는다", () => {
    const f = MAINTENANCE_COPY.formal;
    expect(f.note).toBe("결제가 끝난 주문은 점검이 끝난 뒤 주문 목록에서 확인할 수 있습니다");
    expect(f.ends(TIME)).toBe(`${TIME}에 끝날 예정입니다`);
    expect(MAINTENANCE_COPY.friendly.ends(TIME)).toBe(`${TIME}에 끝날 예정이에요`);
    expect(f.doneHref).toBe("/seller");
    expect(MAINTENANCE_COPY.friendly.doneHref).toBe("/about");
  });
});
