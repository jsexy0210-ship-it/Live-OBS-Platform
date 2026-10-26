import { beforeEach, expect, it, vi } from "vitest";
const owned = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../components/seller/api", () => ({ api: owned.api, failMessage: () => "owned failure" }));
import { isUnclear, sameSet, settleByList } from "../../components/seller/StaffForms";
import { setDetailResult, takeDetailResult } from "../../app/(seller)/seller/(shell)/banners/_shared/detailNavigation";

const list = "/seller/staff", notice = "소유 직원 정보를 저장했습니다";
beforeEach(() => {
  owned.api.mockReset();
  takeDetailResult(list);
});

it("응답 유실은 불분명하며 지연된 실제 목록 회복 전에는 판정을 호출하지 않는다", async () => {
  expect(isUnclear({ status: 0, error: "unknown" })).toBe(true);
  let resolve!: (value: unknown) => void;
  owned.api.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const current = { id: "owned-staff", permissions: ["PRODUCT_MANAGE", "ORDER_SHIPPING"] };
  const judge = vi.fn((rows: typeof current[]) => rows.find(row => row.id === current.id));
  const recovery = settleByList(judge);
  expect(owned.api).toHaveBeenCalledExactlyOnceWith("/api/seller/staff");
  expect(judge).not.toHaveBeenCalled();
  resolve({ ok: true, data: { staff: [current] } });
  expect(await recovery).toBe(current);
  expect(judge).toHaveBeenCalledExactlyOnceWith([current]);
  expect(sameSet(current.permissions, ["ORDER_SHIPPING", "PRODUCT_MANAGE"])).toBe(true);
});

it("목록 읽기 실패는 판정하지 않고 미확인으로 남긴다", async () => {
  owned.api.mockResolvedValueOnce({ ok: false, status: 500, error: "internal" });
  const judge = vi.fn();
  expect(await settleByList(judge)).toBeNull();
  expect(judge).not.toHaveBeenCalled();
});

it("읽은 권한이 다른 경우 같은 값으로 오인하지 않는다", async () => {
  owned.api.mockResolvedValueOnce({ ok: true, data: { staff: [{ id: "owned-staff", permissions: ["PRODUCT_MANAGE"] }] } });
  expect(await settleByList(rows => sameSet(rows.find(row => row.id === "owned-staff")!.permissions, ["PRODUCT_MANAGE", "ORDER_SHIPPING"]))).toBe(false);
});

it("상세 결과 안내는 같은 목록에서 한 번만 소비하며 다른 목록 조회로 잃지 않는다", () => {
  setDetailResult(list, notice);
  expect(takeDetailResult("/seller/reviews")).toBeUndefined();
  expect(takeDetailResult(list)).toBe(notice);
  expect(takeDetailResult(list)).toBeUndefined();
});
