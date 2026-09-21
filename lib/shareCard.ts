import type { BadgeTone } from "@/lib/badges";
import { SITE_HOST } from "@/lib/site";
import { COLORS, TONE_COLOR } from "@/lib/theme";

export type ShareCardInput = {
  title: string;
  value: string;
  factBadge: string;
  impactBadge: string;
  tone: BadgeTone;
};

const W = 1080;
const H = 1350;
const PAD = 88;
const SANS = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';

function fitFont(ctx: CanvasRenderingContext2D, text: string, family: string, weight: number, max: number, maxWidth: number) {
  let size = max;
  do {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 4;
  } while (size > 40);
  return size;
}

function badge(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, fill: string, color: string, stroke?: string) {
  ctx.font = `800 34px ${SANS}`;
  const width = ctx.measureText(text).width + 44;
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width, 68);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, width - 2, 66);
  }
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 22, y + 35);
  return width;
}

/** 결과 공유 카드 PNG (1080×1350). 입력값 미포함, 결과 숫자와 배지만 표기. */
export async function renderShareCard(input: ShareCardInput): Promise<Blob> {
  if (document.fonts?.ready) await document.fonts.ready;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  const tone = TONE_COLOR[input.tone];

  ctx.fillStyle = "#0A0B0E";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 2;
  ctx.strokeRect(PAD / 2, PAD / 2, W - PAD, H - PAD);

  ctx.fillStyle = tone;
  ctx.fillRect(PAD, PAD + 4, 30, 30);
  ctx.fillStyle = COLORS.text;
  ctx.textBaseline = "top";
  ctx.font = `800 34px ${MONO}`;
  ctx.fillText("LIFELEFT · 인생잔량", PAD + 50, PAD);

  ctx.fillStyle = COLORS.axis;
  ctx.font = `700 44px ${SANS}`;
  ctx.fillText(input.title, PAD, 330);

  const maxWidth = W - PAD * 2;
  const size = fitFont(ctx, input.value, MONO, 800, 230, maxWidth);
  ctx.fillStyle = tone;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(input.value, PAD - 6, 420 + size * 0.85);

  const badgeY = 420 + size + 70;
  const first = badge(ctx, PAD, badgeY, input.factBadge, "#181B22", COLORS.text, "#3A3F4B");
  badge(ctx, PAD + first + 16, badgeY, input.impactBadge, tone, "#0A0B0E");

  ctx.fillStyle = COLORS.grid;
  ctx.fillRect(PAD, H - PAD - 150, maxWidth, 2);
  ctx.textBaseline = "top";
  ctx.fillStyle = COLORS.axis;
  ctx.font = `600 30px ${SANS}`;
  ctx.fillText("입력값 기반 추정 · 숫자 우선", PAD, H - PAD - 110);
  ctx.fillStyle = COLORS.text;
  ctx.font = `700 34px ${MONO}`;
  ctx.fillText(SITE_HOST, PAD, H - PAD - 60);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}
