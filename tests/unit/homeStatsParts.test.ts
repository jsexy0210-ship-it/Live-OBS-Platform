import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Kpis } from "../../components/seller/stats/parts";

const item = { label: "주문", now: 12, prev: 10, fmt: (n: number) => `${n}건` };
describe("홈 통계 표시 옵션", () => {
  it("홈 옵션이 없는 다른 통계 화면의 비교 문구는 유지한다", () => {
    const html = renderToStaticMarkup(createElement(Kpis, { items: [item] }));
    expect(html).toContain("바로 앞 기간보다");
    expect(html).toContain("20.0%");
  });
  it("오늘 성과는 비율과 실제 이전값 안내를 함께 표시한다", () => {
    const html = renderToStaticMarkup(createElement(Kpis, { compact: true, caption: "어제 같은 시각", items: [{ ...item, note: "어제 같은 시각 10건" }] }));
    expect(html).toContain("20.0%");
    expect(html).toContain("어제 같은 시각 10건");
    expect(html).not.toContain("바로 앞 기간");
  });
  it("성장은 직전 기간 0건이어도 비율 대신 실제 증감 건수를 보여준다", () => {
    const html = renderToStaticMarkup(createElement(Kpis, { difference: true, caption: "지난 7일", items: [{ ...item, now: 4, prev: 0 }] }));
    expect(html).toContain("지난 7일 대비 ▲ 4");
    expect(html).not.toContain("%");
  });
});
