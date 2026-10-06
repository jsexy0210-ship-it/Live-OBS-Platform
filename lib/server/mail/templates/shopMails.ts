import { type Block, type Brand, type MailBody, dateDay, dateTime, deadline, renderMail, safeColor, signedWon, won } from "./layout";

// 쇼핑몰 구매자 메일 4종(디자인 EM-001 주문 완료 · EM-002 발송 · EM-003 배송 완료 · EM-004 취소·환불). 해요체.
// 부르는 쪽(주문·배송·환불 처리)이 값을 넘기면 제목·텍스트·HTML을 돌려준다. 실제 발송은 mail/quota.ts의 sendMail로 한다(제공량·충전 잔액 차감).

export type ShopMailBrand = {
  shopName: string;
  shopUrl: string; // 표기용 주소(예: onq.example/starlight)
  color?: string | null; // 쇼핑몰 대표색 #rrggbb, 없으면 기본
  mark?: string | null; // 로고 칸 글자(없으면 쇼핑몰 이름 앞 2자)
  business: { name: string; representative: string; businessNumber: string; mailOrderNumber: string; address: string; phone: string; email: string };
};
export type OrderLine = { name: string; quantity: number; amount: number };
export type Receiver = { name: string; phone: string; address: string; memo?: string | null };
export type OrderBase = {
  brand: ShopMailBrand;
  nickname: string; // 방송 닉네임
  orderNoLabel: string; // yyyyMMdd-NNNN
  orderedAt: Date;
  orderUrl: string;
  lines: OrderLine[];
  shippingFee: number;
  freeShippingNote?: string | null; // 예: 50,000원 이상 무료
  rewardUsed: number;
  total: number; // 결제금액(합계)
};

const brandOf = (b: ShopMailBrand): Brand => ({ name: b.shopName, mark: (b.mark ?? b.shopName).slice(0, 2), color: safeColor(b.color), site: b.shopUrl });
const footerOf = (b: ShopMailBrand) => ({
  title: b.shopName,
  lines: [
    `상호 ${b.business.name} · 대표 ${b.business.representative} · 사업자등록번호 ${b.business.businessNumber} · 통신판매업 신고 ${b.business.mailOrderNumber}`,
    `${b.business.address} · 고객센터 ${b.business.phone} · ${b.business.email}`,
    "이 메일은 발신 전용이에요 · 문의는 쇼핑몰 1:1 문의로 남겨 주세요",
  ],
});
const make = (b: ShopMailBrand, subject: string, blocks: Block[]): MailBody => renderMail({ subject: `[${b.shopName}] ${subject}`, brand: brandOf(b), blocks, footer: footerOf(b) });

const receiverBox = (r: Receiver): Block => ({ t: "box", title: "받는 분", lines: [`${r.name} · ${r.phone}`, r.address, ...(r.memo ? [`배송 메모 · ${r.memo}`] : [])] });
const feeExtra = (o: OrderBase) => [
  { label: "배송비", value: o.shippingFee === 0 ? `0원${o.freeShippingNote ? ` · ${o.freeShippingNote}` : ""}` : won(o.shippingFee) },
  ...(o.rewardUsed > 0 ? [{ label: "적립금 사용", value: signedWon(-o.rewardUsed) }] : []),
];
const itemsBlock = (o: OrderBase, label = "합계"): Block => ({ t: "items", lines: o.lines, extra: feeExtra(o), total: { label, value: won(o.total) } });
const summaryBox = (o: OrderBase, payment: string, amount: string): Block => ({
  t: "box",
  rows: [["주문번호", o.orderNoLabel], ["주문일", dateTime(o.orderedAt)], ["결제수단", payment], ["결제금액", amount]],
});

// ─── EM-001 주문 완료 ───
export type OrderCompletedInput = OrderBase &
  (
    | { payment: "CARD"; paymentLabel: string; queueAhead?: number | null } // 예: 카드 · 일시불
    | { payment: "BANK_TRANSFER"; bankName: string; accountNumber: string; accountHolder: string; dueAt: Date; cashReceiptPhone?: string | null }
  ) & { receiver: Receiver };

export function orderCompletedMail(i: OrderCompletedInput): MailBody {
  if (i.payment === "BANK_TRANSFER") {
    return make(i.brand, "주문이 접수됐어요 · 입금을 기다려요", [
      { t: "h1", text: "주문이 접수됐어요 · 입금을 기다려요" },
      { t: "p", text: `${i.nickname}님, 주문해 주셔서 고마워요. 아래 계좌로 입금해 주세요.` },
      { t: "box", accent: true, title: "입금 계좌", rows: [["은행", i.bankName], ["계좌번호", i.accountNumber], ["예금주", i.accountHolder]], lines: [`${won(i.total)}을 ${deadline(i.dueAt)}까지 입금해 주세요`], muted: "입금이 확인되면 주문대기에 올라가고 다시 알려 드려요 · 기한이 지나면 자동 취소돼요" },
      summaryBox(i, "무통장 입금", won(i.total) + " · 입금 전"),
      ...(i.cashReceiptPhone ? [{ t: "box", title: "현금영수증 신청함", lines: [`현금영수증 소득공제 · ${i.cashReceiptPhone} · 입금 확인 뒤 발행돼요`] } as Block] : []),
      itemsBlock(i),
      receiverBox(i.receiver),
      { t: "buttons", buttons: [{ label: "주문 상세 보기", url: i.orderUrl }] },
    ]);
  }
  return make(i.brand, "주문이 접수됐어요", [
    { t: "h1", text: "주문이 접수됐어요" },
    { t: "p", text: `${i.nickname}님, 주문해 주셔서 고마워요. 결제가 확인됐고 주문대기에 올라갔어요.` },
    { t: "box", accent: true, title: `방송에서 순서대로 열어 드려요${i.queueAhead != null ? ` · 지금 앞에 ${i.queueAhead}명` : ""}`, lines: [`방송에서 이 이름으로 불러요 · 방송 닉네임: ${i.nickname}`] },
    summaryBox(i, i.paymentLabel, won(i.total)),
    itemsBlock(i),
    receiverBox(i.receiver),
    { t: "buttons", buttons: [{ label: "주문 상세 보기", url: i.orderUrl }] },
  ]);
}

// ─── EM-002 발송 ───
export type ShippedInput = OrderBase & { carrier: string; trackingNo: string; shippedAt: Date; trackingUrl?: string | null; receiver: Receiver; island?: { extraFee: number } | null };

export function shippedMail(i: ShippedInput): MailBody {
  const count = i.lines.reduce((n, l) => n + l.quantity, 0);
  return make(i.brand, "상품을 보냈어요", [
    { t: "h1", text: "상품을 보냈어요" },
    { t: "p", text: `${i.nickname}님, 개봉이 끝난 상품을 포장해서 보냈어요.` },
    { t: "box", accent: true, rows: [["택배사", i.carrier], ["송장번호", i.trackingNo], ["보낸 날", dateDay(i.shippedAt)]], muted: "보통 1~2일 안에 도착해요. 휴일이 끼면 늦어질 수 있어요." },
    ...(i.island ? [{ t: "box", title: "제주 · 도서지역이라 1~2일 더 걸릴 수 있어요", lines: [`도서산간 추가비 ${won(i.island.extraFee)}은 주문할 때 결제됐어요`] } as Block] : []),
    receiverBox(i.receiver),
    { t: "items", lines: i.lines, extra: i.rewardUsed > 0 ? [{ label: "적립금 사용", value: signedWon(-i.rewardUsed) }] : [], total: { label: "합계", value: `${count}개 · ${won(i.total)}` } },
    { t: "buttons", buttons: [...(i.trackingUrl ? [{ label: "배송 조회", url: i.trackingUrl }] : []), { label: "주문 상세 보기", url: i.orderUrl, secondary: !!i.trackingUrl }] },
  ]);
}

// ─── EM-003 배송 완료 ───
export type DeliveredInput = OrderBase & {
  broadcast?: { date: Date; openedAt?: Date | null; hasHit: boolean } | null; // 개봉한 방송
  rewardEarned?: number | null;
  rewardBalance?: number | null;
  replayUrl?: string | null;
};

export function deliveredMail(i: DeliveredInput): MailBody {
  const count = i.lines.reduce((n, l) => n + l.quantity, 0);
  const b = i.broadcast;
  const kstHm = (d: Date) => dateTime(d).slice(11);
  return make(i.brand, "상품이 도착했어요", [
    { t: "h1", text: "상품이 도착했어요" },
    { t: "p", text: `${i.nickname}님, 보낸 상품이 배송 완료됐어요.` },
    ...(b
      ? [{ t: "box", accent: true, title: "개봉 결과는 방송 다시보기에서 볼 수 있어요", lines: [`${dateTime(b.date).slice(0, 10)} 방송${b.openedAt ? ` · 개봉 시각 ${kstHm(b.openedAt)} 부근` : ""}${b.hasHit ? " · HIT 당첨 카드는 명예의 전당에 올라가 있어요" : ""}`] } as Block]
      : []),
    ...(i.rewardEarned && i.rewardEarned > 0
      ? [{ t: "box", title: `적립금 ${won(i.rewardEarned)}이 쌓였어요`, lines: i.rewardBalance != null ? [`보유 적립금 ${won(i.rewardBalance)} · 다음 주문부터 쓸 수 있어요`] : ["다음 주문부터 쓸 수 있어요"] } as Block]
      : []),
    { t: "p", text: "받은 카드에 문제가 있으면 3일 안에 1:1 문의로 알려 주세요.", muted: true },
    { t: "items", lines: i.lines, extra: i.rewardUsed > 0 ? [{ label: "적립금 사용", value: signedWon(-i.rewardUsed) }] : [], total: { label: "합계", value: `${count}개 · ${won(i.total)}` } },
    { t: "buttons", buttons: [{ label: "주문 상세 보기", url: i.orderUrl }, ...(i.replayUrl ? [{ label: "방송 다시보기", url: i.replayUrl, secondary: true }] : [])] },
  ]);
}

// ─── EM-004 취소·환불 ───
export type RefundMethod = { kind: "CARD"; label?: string } | { kind: "BANK"; bankName: string; accountNumber: string; holder: string };
export type CancelledInput = OrderBase & { paymentLabel: string; refund: RefundMethod; rewardReturned?: number } & (
    | { kind: "FULL"; reason: string; refundAmount: number }
    | { kind: "PARTIAL"; cancelledLines: OrderLine[]; refundAmount: number; remainingTotal: number; remainingLines: OrderLine[] }
    | { kind: "SELLER"; refundAmount: number }
  );

const refundRows = (i: CancelledInput): [string, string][] =>
  i.refund.kind === "CARD" ? [["환불 수단", i.refund.label ?? "카드 · 일시불"], ["결제 취소 예정일", "3~5영업일 안에 카드사 기준으로 반영"]] : [["환불 수단", "무통장 · 입력한 계좌"]];
const refundTail = (i: CancelledInput): Block[] => [
  ...(i.rewardReturned && i.rewardReturned > 0 ? [{ t: "box", title: `적립금 사용한 ${won(i.rewardReturned)}을 돌려드렸어요` } as Block] : []),
  ...(i.refund.kind === "CARD"
    ? [{ t: "p", text: "카드사에 따라 반영 시점이 달라요. 승인 취소 문자는 카드사에서 보내요.", muted: true } as Block]
    : [{ t: "box", title: "무통장 환불 · 입력한 계좌로 돌려 드려요", rows: [["은행", i.refund.bankName], ["계좌번호", i.refund.accountNumber], ["예금주", i.refund.holder]], muted: "1~2영업일 안에 입금돼요 · 계좌가 틀리면 1:1 문의로 알려 주세요" } as Block]),
];

export function cancelledMail(i: CancelledInput): MailBody {
  const detail: Block = summaryBox(i, i.paymentLabel, `${won(i.total)}${i.kind === "FULL" ? " → 환불" : ""}`);
  if (i.kind === "PARTIAL") {
    const names = i.cancelledLines.map((l) => `${l.name} ×${l.quantity}`).join(", ");
    const rest = i.remainingLines.reduce((n, l) => n + l.quantity, 0);
    return make(i.brand, "주문 일부를 취소했어요", [
      { t: "h1", text: "주문 일부를 취소했어요" },
      { t: "p", text: `${i.nickname}님, 요청하신 일부 취소가 끝났어요.` },
      { t: "box", accent: true, title: `${names} · ${won(i.cancelledLines.reduce((n, l) => n + l.amount, 0))} 취소`, rows: [["환불 금액", won(i.refundAmount)], ...refundRows(i)], muted: "나머지 상품은 그대로 진행돼요" },
      ...refundTail(i),
      detail,
      { t: "items", lines: i.remainingLines, extra: i.rewardUsed > 0 ? [{ label: "적립금 사용", value: signedWon(-i.rewardUsed) }] : [], total: { label: `합계 남은 주문 ${rest}개`, value: won(i.remainingTotal) } },
      { t: "buttons", buttons: [{ label: "주문 상세 보기", url: i.orderUrl }] },
    ]);
  }
  const seller = i.kind === "SELLER";
  return make(i.brand, "주문을 취소했어요", [
    { t: "h1", text: "주문을 취소했어요" },
    { t: "p", text: seller ? "죄송해요. 상품이 품절돼 판매자가 취소했어요." : `${i.nickname}님, 요청하신 주문 취소가 끝났어요.` },
    { t: "box", accent: true, rows: [...(i.kind === "FULL" ? ([["취소 사유", i.reason]] as [string, string][]) : []), ["환불 금액", won(i.refundAmount)], ...refundRows(i)], muted: seller ? "결제 금액 전액을 돌려 드려요 · 환불 수단과 예정일은 위와 같아요" : undefined },
    ...refundTail(i),
    detail,
    itemsBlock(i),
    { t: "buttons", buttons: [{ label: "주문 상세 보기", url: i.orderUrl }] },
  ]);
}
