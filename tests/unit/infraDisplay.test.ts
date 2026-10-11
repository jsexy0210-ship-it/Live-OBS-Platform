import { describe, expect, it } from "vitest";
import { CPU_LOAD_LABEL, infraCollectionFailed, infraDisplayLevel, infraPercentText } from "../../lib/client/infraDisplay";

const now = Date.parse("2026-10-11T00:00:00Z");
const snapshot = (value: number | null, age = 0) => ({ takenAt: new Date(now - age).toISOString(), disk: { usedPct: value }, memory: { usedPct: value }, cpu: { usedPct: value } });

describe("인프라 측정 상태 표시", () => {
  it("1분 부하는 사용률로 오인하지 않고 100% 초과도 원래 값으로 표시한다", () => {
    expect(CPU_LOAD_LABEL).toBe("CPU 1분 부하(코어 대비)");
    expect(infraPercentText(2924.5)).toBe("2924.5%");
  });
  it("측정 전과 비유한 값은 —이고 실제 0은 0%다", () => {
    expect([null, NaN, Infinity, -Infinity].map(infraPercentText)).toEqual(["—", "—", "—", "—"]);
    expect(infraPercentText(0)).toBe("0%");
  });
  it("현재 측정 누락은 실패이고 유효한 0이나 일부 측정 성공은 실패로 세지 않는다", () => {
    expect(infraCollectionFailed(snapshot(null), true, now)).toBe(true);
    expect(infraCollectionFailed(snapshot(NaN), true, now)).toBe(true);
    expect(infraCollectionFailed(snapshot(0), true, now)).toBe(false);
    expect(infraCollectionFailed({ ...snapshot(null), cpu: { usedPct: 0 } }, true, now)).toBe(false);
  });
  it("기존 보고 실패 경계인 3시간 초과를 유지한다", () => {
    expect(infraCollectionFailed(snapshot(0, 3 * 3_600_000), false, now)).toBe(false);
    expect(infraCollectionFailed(snapshot(0, 3 * 3_600_000 + 1), false, now)).toBe(true);
  });
  it("수집 실패가 위험·경고·정상보다 우선한다", () => {
    expect([infraDisplayLevel(1, 1, 1), infraDisplayLevel(0, 1, 1), infraDisplayLevel(0, 0, 1), infraDisplayLevel(0, 0, 0)]).toEqual(["lost", "crit", "warn", "ok"]);
  });
});
