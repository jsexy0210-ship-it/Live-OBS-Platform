import { describe, expect, it } from "vitest";
import type { PlatformAdminRole } from "@prisma/client";
import { ADMIN_PERMISSIONS, OWNER_ONLY_ACTIONS, STAFF_PERMISSIONS, adminCan, sellerCan, type AdminPermission } from "../../lib/server/authz/permissions";
import { assertWritable, canViewCustomerPii, requireSellerPermission, requireSellerRead, type TenantContext } from "../../lib/server/tenant/context";

const perms = Object.keys(ADMIN_PERMISSIONS) as AdminPermission[];
const allowed = (role: PlatformAdminRole) => perms.filter((p) => adminCan(role, p)).sort();

describe("마스터 역할 권한 표", () => {
  it("최고관리자는 모든 권한", () => {
    expect(allowed("SUPER_ADMIN")).toEqual([...perms].sort());
  });

  it("조회 전용은 조회만 (변경 권한 없음)", () => {
    expect(allowed("READ_ONLY")).toEqual(["audit.read", "platform.read"]);
  });

  it("운영은 판매자 관리·구독·대리 조회, 관리자 계정·시스템 설정은 불가", () => {
    expect(adminCan("OPERATIONS", "seller.moderate")).toBe(true);
    expect(adminCan("OPERATIONS", "billing.manage")).toBe(true);
    expect(adminCan("OPERATIONS", "admin.manage")).toBe(false);
    expect(adminCan("OPERATIONS", "system.manage")).toBe(false);
    expect(adminCan("OPERATIONS", "support.manage")).toBe(false);
  });

  it("CS는 문의·공지와 대리 조회만", () => {
    expect(allowed("CS")).toEqual(["platform.read", "seller.impersonate", "support.assign", "support.manage"]);
    expect(adminCan("OPERATIONS", "support.assign")).toBe(true);
    expect(adminCan("READ_ONLY", "support.assign")).toBe(false);
  });
});

describe("판매자 권한 항목 (대표자 전용 기능 포함)", () => {
  const staff = (permissions: TenantContext["permissions"]) => ({ isOwner: false, permissions });

  it("대표자는 모든 권한 항목과 대표자 전용 기능", () => {
    for (const a of [...STAFF_PERMISSIONS, ...OWNER_ONLY_ACTIONS]) expect(sellerCan({ isOwner: true, permissions: [] }, a)).toBe(true);
  });

  it("직원은 켠 권한 항목만", () => {
    const s = staff(["BROADCAST_RUN", "OVERLAY_EDIT"]);
    expect(sellerCan(s, "BROADCAST_RUN")).toBe(true);
    expect(sellerCan(s, "OVERLAY_EDIT")).toBe(true);
    expect(sellerCan(s, "ORDER_SHIPPING")).toBe(false);
    expect(sellerCan(s, "CUSTOMER_PII_VIEW")).toBe(false);
  });

  it("대표자 전용 기능은 권한 항목을 모두 켜도 직원에게 불가", () => {
    const all = staff([...STAFF_PERMISSIONS]);
    for (const a of OWNER_ONLY_ACTIONS) expect(sellerCan(all, a)).toBe(false);
  });

  it("권한 항목은 10개", () => {
    expect(STAFF_PERMISSIONS).toHaveLength(10);
  });
});

describe("테넌트 컨텍스트", () => {
  const base: TenantContext = { sellerId: "s", actorType: "SELLER_USER", actorId: "u", isOwner: false, permissions: ["ORDER_SHIPPING"], readOnly: false };

  it("권한 항목이 없으면 403", () => {
    expect(() => requireSellerPermission({ ...base, permissions: ["BROADCAST_RUN"] }, "ORDER_SHIPPING")).toThrow("forbidden");
    expect(() => requireSellerPermission(base, "ORDER_SHIPPING")).not.toThrow();
  });

  it("고객 정보 보기 권한이 있어야 이름·연락처를 응답에 넣는다", () => {
    expect(canViewCustomerPii(base)).toBe(false);
    expect(canViewCustomerPii({ ...base, permissions: ["ORDER_SHIPPING", "CUSTOMER_PII_VIEW"] })).toBe(true);
  });

  it("대리 조회(읽기 전용)는 정해 둔 조회만 허용하고 변경은 403", () => {
    const ro: TenantContext = { ...base, actorType: "PLATFORM_ADMIN", permissions: [], readOnly: true, impersonationScopes: ["ORDERS"] };
    expect(() => requireSellerRead(ro, "ORDER_SHIPPING")).not.toThrow();
    expect(() => requireSellerRead(ro, "BROADCAST_RUN")).toThrow("forbidden");
    expect(() => requireSellerPermission(ro, "ORDER_SHIPPING")).toThrow("forbidden");
    expect(() => assertWritable(ro)).toThrow("forbidden");
  });

  it("대리 조회는 고른 열람 범위 밖 조회를 out_of_scope로 막고, 구매자 연락처는 어떤 범위에서도 가린다", () => {
    const ro: TenantContext = { ...base, actorType: "PLATFORM_ADMIN", permissions: [], readOnly: true, impersonationScopes: ["ORDERS"] };
    expect(() => requireSellerRead(ro, "MEMBER_POINTS")).toThrow("out_of_scope");
    expect(() => requireSellerRead({ ...ro, impersonationScopes: ["MEMBERS"] }, "MEMBER_POINTS")).not.toThrow();
    // 범위가 없는(이전 형태) 컨텍스트는 열어 주지 않는다
    expect(() => requireSellerRead({ ...ro, impersonationScopes: undefined }, "ORDER_SHIPPING")).toThrow("out_of_scope");
    expect(canViewCustomerPii({ ...ro, impersonationScopes: ["ORDERS", "MEMBERS", "SETTINGS_PG"] })).toBe(false);
  });
});
