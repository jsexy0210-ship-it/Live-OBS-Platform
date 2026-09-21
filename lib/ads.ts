export const ADSENSE_CLIENT = "ca-pub-3588439746208886";

// AdSense 콘솔 > 광고 > 광고 단위 기준 > 디스플레이 광고에서 발급한 data-ad-slot 값.
// 빈 값이면 해당 위치는 렌더링하지 않음(자동 광고만 동작).
export const AD_SLOTS = {
  homeMiddle: "",
  homeBottom: "",
  calculatorBottom: ""
} as const;

export type AdSlotKey = keyof typeof AD_SLOTS;
