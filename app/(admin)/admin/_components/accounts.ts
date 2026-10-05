// 마스터 관리자 계정(GET·POST /api/admin/admins, PATCH …/{id}, MA-061·062)과 역할별 권한 표(GET /api/admin/permissions, MA-063) 응답·문구.
// 최고관리자는 유일하다(대표님 지시 2026-10-04): 화면에서도 최고관리자 행의 역할·상태 변경과 「최고관리자」 선택지를 만들지 않는다.
export type AdminRoleCode = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
export type AdminStatus = "ACTIVE" | "SUSPENDED";
export type AdminAccount = { id: string; email: string; name: string; role: AdminRoleCode; status: AdminStatus; lastLoginAt: string | null; createdAt: string };
export type PermissionTable = {
  roles: AdminRoleCode[];
  permissions: { permission: string; roles: AdminRoleCode[] }[];
  byRole: Record<AdminRoleCode, string[]>;
};

export const ROLE_LABEL: Record<AdminRoleCode, string> = { SUPER_ADMIN: "최고관리자", OPERATIONS: "운영", CS: "고객 지원", READ_ONLY: "조회 전용" };
// 선택지에는 최고관리자가 없다
export const ASSIGNABLE_ROLES: AdminRoleCode[] = ["OPERATIONS", "CS", "READ_ONLY"];
export const STATUS_LABEL: Record<AdminStatus, { label: string; cls: string }> = {
  ACTIVE: { label: "이용 중", cls: "b-done" },
  SUSPENDED: { label: "정지", cls: "b-fail" },
};
export const PERMISSION_LABEL: Record<string, string> = {
  "platform.read": "전체 조회",
  "seller.moderate": "파트너스 이용 정지·해제",
  "billing.manage": "청구·요금 관리",
  "billing.price": "요금제 가격 변경",
  "support.manage": "고객지원 관리",
  "seller.impersonate": "파트너스 화면 대리 조회",
  "admin.manage": "관리자 계정 관리",
  "system.manage": "시스템 설정",
  "audit.read": "로그 추적 조회",
};
export const MIN_PASSWORD = 8;
