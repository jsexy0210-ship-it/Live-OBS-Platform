import { describe, expect, it } from "vitest";
import type { PlatformAdminRole } from "@prisma/client";
import { ADMIN_PERMISSIONS, adminCan, sellerCan, type AdminPermission } from "../../lib/server/authz/permissions";
import { assertWritable, requireSellerPermission, type TenantContext } from "../../lib/server/tenant/context";

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
    expect(allowed("CS")).toEqual(["platform.read", "seller.impersonate", "support.manage"]);
  });
});

describe("판매자 직원 역할 권한 표", () => {
  it("대표만 실지급 스위치·구독·PG·직원 관리", () => {
    for (const p of ["reward.livePayout", "subscription.manage", "pg.manage", "staff.manage"] as const) {
      expect(sellerCan("OWNER", p)).toBe(true);
      expect(sellerCan("MANAGER", p)).toBe(false);
      expect(sellerCan("BROADCASTER", p)).toBe(false);
    }
  });

  it("방송 담당은 방송·오버레이만", () => {
    expect(sellerCan("BROADCASTER", "broadcast.operate")).toBe(true);
    expect(sellerCan("BROADCASTER", "overlay.manage")).toBe(true);
    expect(sellerCan("BROADCASTER", "order.read")).toBe(false);
    expect(sellerCan("BROADCASTER", "product.manage")).toBe(false);
  });
});

describe("테넌트 컨텍스트", () => {
  const base: TenantContext = { sellerId: "s", actorType: "SELLER_USER", actorId: "u", sellerRole: "MANAGER", readOnly: false };

  it("역할에 없는 권한은 403", () => {
    expect(() => requireSellerPermission({ ...base, sellerRole: "BROADCASTER" }, "order.read")).toThrow("forbidden");
    expect(() => requireSellerPermission(base, "order.read")).not.toThrow();
  });

  it("대리 조회(읽기 전용)는 조회만 허용하고 변경은 403", () => {
    const ro: TenantContext = { ...base, actorType: "PLATFORM_ADMIN", sellerRole: null, readOnly: true };
    expect(() => requireSellerPermission(ro, "order.read")).not.toThrow();
    expect(() => requireSellerPermission(ro, "order.manage")).toThrow("forbidden");
    expect(() => assertWritable(ro)).toThrow("forbidden");
  });
});
