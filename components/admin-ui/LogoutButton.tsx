"use client";

import { useConfirm } from "./ConfirmDialog";

// 로그아웃 공통 버튼: 누르면 반드시 확인 창(관리자 「로그아웃하시겠습니까?」·구매자 「로그아웃할까요?」)을 거친 뒤에만 로그아웃한다(대표님 지시 2026-10-06, 정본 DS-CONFIRM ⑦).
// 셸마다 로그아웃 요청만 onLogout으로 넘긴다(성공하면 true, 실패하면 false). 실패하면 창 안에 오류를 보이고 열어 둔 채 다시 시도하게 한다(실패했는데 로그아웃된 척 이동하지 않는다).
// 대신 보기 중에도 로그아웃은 된다(allowReadOnly). 로그아웃을 부르는 곳은 이 버튼 하나만 둔다(직접 요청 금지).
const TEXT = {
  admin: { title: "로그아웃하시겠습니까?", body: "이 기기에서 로그아웃됩니다 · 저장하지 않은 입력은 사라집니다.", failed: "로그아웃하지 못했습니다. 다시 시도해 주십시오" },
  shop: { title: "로그아웃할까요?", body: "이 기기에서 로그아웃돼요.", failed: "로그아웃하지 못했어요. 잠시 뒤 다시 시도해 주세요" },
} as const;

export function LogoutButton({
  onLogout,
  tone = "admin",
  className = "util-i util-btn",
  children = "로그아웃",
}: {
  onLogout: () => Promise<boolean>;
  tone?: "admin" | "shop";
  className?: string;
  children?: React.ReactNode;
}) {
  const { confirm } = useConfirm();
  const t = TEXT[tone];
  return (
    <button
      className={className}
      type="button"
      onClick={() =>
        void confirm({
          tone,
          title: t.title,
          body: t.body,
          confirmLabel: "로그아웃",
          allowReadOnly: true,
          run: async () => ((await onLogout()) ? undefined : t.failed),
        })
      }
    >
      {children}
    </button>
  );
}
