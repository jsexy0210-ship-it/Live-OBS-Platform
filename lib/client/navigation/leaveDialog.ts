// 저장하지 않은 변경을 두고 나갈 때 묻는 공통 확인 창(.cfm, DS-CONFIRM 정본)의 연결부.
// 셸의 ConfirmProvider가 창을 띄우는 함수를 등록하고, useUnsavedGuard가 화면이 고른 문구로 부른다.
// 등록된 창이 없거나 화면이 창을 고르지 않으면 기존 브라우저 확인 창을 그대로 쓴다.
export type LeaveDialog = {
  title: string;
  body?: string;
  // 기본 「계속 편집」 / 「저장 안 함」(정본 SA-016 저장 전 나가기 확인)
  stayLabel?: string;
  leaveLabel?: string;
};

type Ask = (dialog: LeaveDialog) => Promise<boolean>;
let host: Ask | null = null;

// 등록을 거두는 함수를 돌려준다(다른 틀이 그사이 다시 등록했으면 건드리지 않는다)
export function registerLeaveDialogHost(ask: Ask): () => void {
  host = ask;
  return () => {
    if (host === ask) host = null;
  };
}

export const leaveDialogAvailable = () => host !== null;

/** true = 저장하지 않고 나간다, false = 계속 편집한다. 등록된 창이 없으면 브라우저 확인 창으로 묻는다 */
export function askLeaveDialog(dialog: LeaveDialog): Promise<boolean> {
  return host ? host(dialog) : Promise.resolve(window.confirm(dialog.body ? `${dialog.title}\n${dialog.body}` : dialog.title));
}
