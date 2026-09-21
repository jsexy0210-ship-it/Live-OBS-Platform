import type { BadgeTone } from "@/lib/badges";

// 차트(SVG 속성)용 색상. globals.css :root 토큰과 동일 값 유지.
export const COLORS = {
  panel: "#12141A",
  grid: "#23262F",
  axis: "#8A91A0",
  text: "#F2F3F5",
  track: "#262A34",
  lime: "#C8F560",
  amber: "#FFB224",
  orange: "#FF6B2C",
  red: "#FF3355"
} as const;

export const TONE_COLOR: Record<BadgeTone, string> = {
  neutral: COLORS.lime,
  watch: COLORS.amber,
  danger: COLORS.orange,
  critical: COLORS.red
};
