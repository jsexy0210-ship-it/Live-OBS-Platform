// AU-010 점검 중 화면 문구. 파트너스 관리자(/seller) 주소에서 보일 때는 관리자 말투(합니다체·「~해 주십시오」),
// 공개·구매자 쇼핑몰에서 보일 때는 토스식 해요체(CLAUDE.md 「화면 문구」). 안내 문구를 비워 둔 채 점검 중일 때의 기본 문구도 여기서 정한다.
// 마스터 관리자가 직접 쓴 안내 문구(PlatformMaintenance.message)는 어느 말투에서도 쓴 그대로 보여 준다.
export type MaintenanceTone = "friendly" | "formal";

export const MAINTENANCE_COPY: Record<
  MaintenanceTone,
  { title: string; fallback: string; ends: (time: string) => string; note: string; doneTitle: string; doneBody: string; doneCta: string; doneHref: string }
> = {
  friendly: {
    title: "지금은 점검 중이에요",
    fallback: "더 안정적으로 이용하실 수 있게 서비스를 점검하고 있어요. 잠시 뒤에 다시 이용해 주세요.",
    ends: (t) => `${t}에 끝날 예정이에요`,
    note: "결제가 끝난 주문은 점검이 끝난 뒤 주문 내역에서 확인할 수 있어요",
    doneTitle: "점검이 끝났어요",
    doneBody: "이제 다시 이용할 수 있어요.",
    doneCta: "처음으로",
    doneHref: "/about",
  },
  formal: {
    title: "지금은 점검 중입니다",
    fallback: "서비스를 점검하고 있습니다. 잠시 뒤에 다시 이용해 주십시오.",
    ends: (t) => `${t}에 끝날 예정입니다`,
    note: "점검 중에는 파트너스 관리자를 이용할 수 없습니다",
    doneTitle: "점검이 끝났습니다",
    doneBody: "이제 다시 이용할 수 있습니다.",
    doneCta: "홈으로",
    doneHref: "/seller",
  },
};

// 프록시가 /seller 주소를 이 화면으로 돌릴 때만 붙이는 값(?area=partners). 그 밖의 값은 모두 해요체.
export const PARTNERS_AREA = "partners";
export const maintenanceTone = (area: string | string[] | undefined): MaintenanceTone => (area === PARTNERS_AREA ? "formal" : "friendly");
