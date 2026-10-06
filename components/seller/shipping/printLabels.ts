// 송장 라벨 출력(SA-028). 서버가 돌려준 라벨 자료로 인쇄 창을 열어 브라우저 인쇄를 부른다. 실제 택배사 라벨이 아니라 모의 자료다.
export type Label = {
  invoiceId: string;
  courierName: string;
  trackingNumber: string;
  mock: boolean;
  orders: { orderNoLabel: string; nickname: string | null; itemSummary: { firstProductName: string | null; otherCount: number } }[];
  recipient: { name: string; phone: string; zipCode: string; address1: string; address2: string | null } | null;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function printLabels(labels: Label[], format: "LABEL_100X150" | "A4_2UP"): boolean {
  const w = window.open("", "_blank", "width=720,height=900");
  if (!w) return false;
  const label = (l: Label) => `<section>
<b>${esc(l.courierName)} ${esc(l.trackingNumber)}</b>${l.mock ? " <small>(모의)</small>" : ""}
<p>${l.recipient ? `${esc(l.recipient.name)} · ${esc(l.recipient.phone)}<br>[${esc(l.recipient.zipCode)}] ${esc(l.recipient.address1)}${l.recipient.address2 ? ` ${esc(l.recipient.address2)}` : ""}` : "받는 분 정보는 권한이 있는 계정만 볼 수 있습니다"}</p>
<ul>${l.orders.map((o) => `<li>${esc(o.orderNoLabel)} · ${esc(o.nickname ?? "")} · ${esc(o.itemSummary.firstProductName ?? "")}${o.itemSummary.otherCount > 0 ? ` 외 ${o.itemSummary.otherCount}건` : ""}</li>`).join("")}</ul>
</section>`;
  const page = format === "LABEL_100X150" ? "@page{size:100mm 150mm;margin:4mm}section{page-break-after:always;height:140mm}" : "@page{size:A4;margin:10mm}section{height:130mm;border-bottom:1px dashed #999}section:nth-child(2n){page-break-after:always}";
  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>송장 출력</title><style>body{font:14px/1.5 sans-serif;margin:0}${page}section{padding:6mm;box-sizing:border-box}</style></head><body>${labels.map(label).join("")}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
  return true;
}
