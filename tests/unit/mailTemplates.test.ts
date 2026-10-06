import { describe, expect, it } from "vitest";
import { cancelledMail, deliveredMail, orderCompletedMail, partnerApprovedMail, partnerRejectedMail, shippedMail, type MailBody } from "../../lib/server/mail/templates";
import { dateDay, dateTime, deadline, safeColor, safeUrl, signedWon, won } from "../../lib/server/mail/templates/layout";

// 메일 템플릿 미리보기 시험(디자인 EM-001~004·101·102 v321): 문구·구조·이스케이프·접근성 기준을 샘플 값으로 확인한다.
const brand = {
  shopName: "카드숍 별빛",
  shopUrl: "onq.example/starlight",
  color: "#5b3df6",
  business: { name: "별빛상사", representative: "김대표", businessNumber: "123-45-67890", mailOrderNumber: "2026-서울강남-0001", address: "서울 강남구 테헤란로 1", phone: "02-000-0000", email: "cs@example.com" },
};
const base = {
  brand,
  nickname: "별구름",
  orderNoLabel: "20261002-0007",
  orderedAt: new Date("2026-10-02T11:41:00Z"), // KST 20:41
  orderUrl: "https://onq.example/starlight/orders/1",
  lines: [
    { name: "스타라이트 부스터 박스", quantity: 2, amount: 178_200 },
    { name: "문라이트 컬렉션 박스", quantity: 1, amount: 132_000 },
  ],
  shippingFee: 0,
  freeShippingNote: "50,000원 이상 무료",
  rewardUsed: 10_000,
  total: 300_200,
};
const receiver = { name: "김구매", phone: "010-0000-0000", address: "서울 마포구 월드컵로 1", memo: "문 앞에 두세요" };
const platform = { name: "온큐 주식회사", representative: "박플랫폼", businessNumber: "000-00-00000", address: "서울 중구 세종대로 1", phone: "1588-0000", url: "onq.example" };

const all: [string, MailBody][] = [
  ["EM-001 카드", orderCompletedMail({ ...base, payment: "CARD", paymentLabel: "카드 · 일시불", queueAhead: 11, receiver })],
  ["EM-001 무통장", orderCompletedMail({ ...base, payment: "BANK_TRANSFER", bankName: "신한은행", accountNumber: "110-000-000000", accountHolder: "별빛상사", dueAt: new Date("2026-10-03T11:41:00Z"), cashReceiptPhone: "010-0000-0000", receiver })],
  ["EM-002", shippedMail({ ...base, carrier: "CJ대한통운", trackingNo: "1234567890", shippedAt: new Date("2026-10-05T03:00:00Z"), trackingUrl: "https://track.example/1234567890", receiver })],
  ["EM-002 도서산간", shippedMail({ ...base, carrier: "CJ대한통운", trackingNo: "1234567890", shippedAt: new Date("2026-10-05T03:00:00Z"), receiver, island: { extraFee: 3000 } })],
  ["EM-003", deliveredMail({ ...base, broadcast: { date: new Date("2026-10-02T11:00:00Z"), openedAt: new Date("2026-10-02T11:48:00Z"), hasHit: true }, rewardEarned: 9306, rewardBalance: 41706, replayUrl: "https://onq.example/starlight/replay/1" })],
  ["EM-004 전체", cancelledMail({ ...base, kind: "FULL", reason: "구매자 요청 · 개봉 전", refundAmount: 300_200, paymentLabel: "카드 · 일시불", refund: { kind: "CARD" }, rewardReturned: 10_000 })],
  ["EM-004 부분", cancelledMail({ ...base, kind: "PARTIAL", cancelledLines: [base.lines[1]], refundAmount: 132_000, remainingLines: [base.lines[0]], remainingTotal: 168_200, paymentLabel: "카드 · 일시불", refund: { kind: "CARD" } })],
  ["EM-004 무통장", cancelledMail({ ...base, kind: "FULL", reason: "구매자 요청", refundAmount: 300_200, paymentLabel: "무통장 입금", refund: { kind: "BANK", bankName: "국민은행", accountNumber: "000-00-000000", holder: "김구매" } })],
  ["EM-004 품절", cancelledMail({ ...base, kind: "SELLER", refundAmount: 300_200, paymentLabel: "카드 · 일시불", refund: { kind: "CARD" } })],
  ["EM-101 체험", partnerApprovedMail({ platform, representative: "김대표", shopName: "카드숍 별빛", shopUrl: "onq.example/starlight", adminUrl: "https://admin.onq.example/login", loginEmail: "owner@example.com", plan: "TRIAL", trialDays: 7, trialEndsAt: new Date("2026-10-08T15:00:00Z") })],
  ["EM-101 통합", partnerApprovedMail({ platform, representative: "김대표", shopName: "카드숍 별빛", shopUrl: "onq.example/starlight", adminUrl: "https://admin.onq.example/login", loginEmail: "owner@example.com", plan: "INTEGRATED", launchMonthly: 179_000, regularMonthly: 249_000 })],
  ["EM-102 반려", partnerRejectedMail({ platform, representative: "김대표", shopName: "카드숍 별빛", statusUrl: "https://admin.onq.example/apply/status", kind: "REJECTED", reason: "사업자등록번호가 휴업 상태예요", note: "휴업 해제 후 다시 신청해 주세요", reapplyUrl: "https://admin.onq.example/apply" })],
  ["EM-102 보완", partnerRejectedMail({ platform, representative: "김대표", shopName: "카드숍 별빛", statusUrl: "https://admin.onq.example/apply/status", kind: "SUPPLEMENT", reason: "통신판매업 신고증을 올려 주세요", daysLeft: 7 })],
];

describe("메일 공통 기준", () => {
  it.each(all)("%s: 제목·텍스트·HTML이 있고 600px · 버튼 44px 이상 · 남은 [자리표시] 없음 · HTML 태그가 텍스트에 없음", (_name, m) => {
    expect(m.subject.startsWith("[")).toBe(true);
    expect(m.html.startsWith("<!doctype html>")).toBe(true);
    expect(m.html).toContain('width="600"');
    expect(m.html).toContain('lang="ko"');
    for (const btn of m.html.match(/<a [^>]*>/g) ?? []) {
      expect(btn).toContain("min-height:44px");
      expect(btn).toMatch(/href="https?:\/\//);
    }
    expect(m.text).not.toMatch(/<[a-z][^>]*>/i);
    expect(m.html + m.text).not.toMatch(/\[(방송 닉네임|주문번호|상호|대표자명|쇼핑몰 주소|플랫폼)/);
    expect(m.text).toContain("이 메일은 발신 전용이에요");
  });
});

describe("쇼핑몰 메일(EM-001~004)", () => {
  it("EM-001 카드: 접수·주문대기 안내·표기(주문일 KST 연월일·금액·적립금·배송비)", () => {
    const m = all[0][1];
    expect(m.subject).toBe("[카드숍 별빛] 주문이 접수됐어요");
    expect(m.text).toContain("스타라이트 부스터 박스 x 2  178,200원");
    expect(m.html).toContain("수량 2");
    for (const s of ["별구름님, 주문해 주셔서 고마워요", "지금 앞에 11명", "방송 닉네임: 별구름", "20261002-0007", "2026.10.02 20:41", "카드 · 일시불", "300,200원", "178,200원", "배송비", "0원 · 50,000원 이상 무료", "−10,000원", "문 앞에 두세요", "주문 상세 보기", "통신판매업 신고 2026-서울강남-0001"]) expect(m.text).toContain(s);
  });
  it("EM-001 무통장: 입금 계좌·기한·현금영수증 안내", () => {
    const m = all[1][1];
    expect(m.subject).toBe("[카드숍 별빛] 주문이 접수됐어요 · 입금을 기다려요");
    for (const s of ["신한은행", "110-000-000000", "예금주: 별빛상사", "300,200원을 10월 3일 (토) 오후 8시 41분까지 입금해 주세요", "기한이 지나면 자동 취소돼요", "현금영수증 신청함", "입금 확인 뒤 발행돼요"]) expect(m.text).toContain(s);
  });
  it("EM-002 발송: 택배·송장·보낸 날·합계 개수, 조회 버튼은 주소가 있을 때만, 도서산간 안내", () => {
    expect(all[2][1].text).toContain("보낸 날: 2026.10.05 (월)");
    expect(all[2][1].text).toContain("합계  3개 · 300,200원");
    expect(all[2][1].text).toContain("문라이트 컬렉션 박스 x 1  132,000원");
    expect(all[2][1].text).toContain("배송 조회: https://track.example/1234567890");
    expect(all[3][1].text).not.toContain("배송 조회");
    expect(all[3][1].text).toContain("제주 · 도서지역이라 1~2일 더 걸릴 수 있어요");
    expect(all[3][1].text).toContain("도서산간 추가비 3,000원은 주문할 때 결제됐어요");
  });
  it("EM-003 배송 완료: 개봉 결과·HIT·적립금·3일 안내, 정보가 없으면 그 칸을 뺀다", () => {
    const m = all[4][1];
    for (const s of ["상품이 도착했어요", "2026.10.02 방송 · 개봉 시각 20:48 부근 · HIT 당첨 카드는 명예의 전당에 올라가 있어요", "적립금 9,306원이 쌓였어요", "보유 적립금 41,706원", "3일 안에 1:1 문의로 알려 주세요", "방송 다시보기: https://onq.example/starlight/replay/1"]) expect(m.text).toContain(s);
    const bare = deliveredMail({ ...base, rewardUsed: 0 });
    expect(bare.text).not.toContain("적립금");
    expect(bare.text).not.toContain("개봉 결과는");
  });
  it("EM-004 취소: 전체(카드·적립금 반환)·부분·무통장·품절 변형", () => {
    const [full, part, bank, soldOut] = [all[5][1], all[6][1], all[7][1], all[8][1]];
    for (const s of ["주문을 취소했어요", "취소 사유: 구매자 요청 · 개봉 전", "환불 금액: 300,200원", "3~5영업일 안에 카드사 기준으로 반영", "적립금 사용한 10,000원을 돌려드렸어요", "승인 취소 문자는 카드사에서 보내요", "300,200원 → 환불"]) expect(full.text).toContain(s);
    for (const s of ["주문 일부를 취소했어요", "문라이트 컬렉션 박스 ×1 · 132,000원 취소", "나머지 상품은 그대로 진행돼요", "합계 남은 주문 2개  168,200원"]) expect(part.text).toContain(s);
    for (const s of ["무통장 환불 · 입력한 계좌로 돌려 드려요", "국민은행", "1~2영업일 안에 입금돼요", "계좌가 틀리면 1:1 문의로 알려 주세요"]) expect(bank.text).toContain(s);
    expect(bank.text).not.toContain("카드사");
    expect(soldOut.text).toContain("죄송해요. 상품이 품절돼 판매자가 취소했어요.");
    expect(soldOut.text).toContain("결제 금액 전액을 돌려 드려요");
  });
});

describe("파트너스 메일(EM-101·102)", () => {
  it("EM-101 체험: 로그인 안내·체험 기간·다음 할 일 3단계, 헤더는 ONQ 파트너스", () => {
    const m = all[9][1];
    expect(m.subject).toBe("[ONQ] 가입이 승인됐어요");
    for (const s of ["김대표님, 카드숍 별빛의 파트너스 가입이 승인됐어요", "owner@example.com", "가입 신청 때 정한 비밀번호예요", "오늘부터 7일 동안 체험해 보세요", "2026.10.09까지 체험할 수 있어요", "3. 체험 기간 안에 구독을 시작하면 끊기지 않아요", "구매자에게는 첫 상품을 올린 뒤에 보여요", "파트너스 관리자로 가기", "상호 온큐 주식회사"]) expect(m.text).toContain(s);
    expect(m.html).toContain("ONQ 파트너스");
  });
  it("EM-101 쇼핑몰 통합: 체험 없이 구독 결제, 런칭 할인가·정가 안내", () => {
    const m = all[10][1];
    for (const s of ["쇼핑몰 통합은 체험 없이 구독 결제로 시작해요", "구독을 시작하면 바로 스토어가 열려요", "월 179,000원(부가세 포함) · 정가 249,000원", "할인이 끝나는 날짜는 30일 전에 알려 드려요", "2. 구독을 시작해요"]) expect(m.text).toContain(s);
    expect(m.text).not.toContain("체험 기간");
  });
  it("EM-102 반려·보완 요청", () => {
    const rej = all[11][1];
    for (const s of ["가입 신청을 승인하지 못했어요", "승인하지 못한 이유", "사업자등록번호가 휴업 상태예요", "담당자 메모: 휴업 해제 후 다시 신청해 주세요", "앞서 적은 내용은 그대로 불러와요", "고쳐서 다시 신청하기: https://admin.onq.example/apply", "신청 상태 보기"]) expect(rej.text).toContain(s);
    const sup = all[12][1];
    for (const s of ["서류를 보완해 주세요", "통신판매업 신고증을 올려 주세요", "7일 안에 올리지 않으면 신청이 취소돼요"]) expect(sup.text).toContain(s);
    expect(partnerRejectedMail({ platform, representative: "a", shopName: "b", statusUrl: "https://x.example/s", kind: "SUPPLEMENT", reason: "r", daysLeft: 0.2 }).text).toContain("1일 안에");
    expect(partnerRejectedMail({ platform, representative: "a", shopName: "b", statusUrl: "https://x.example/s", kind: "REJECTED", reason: "r", reapplyUrl: "https://x.example/a" }).text).not.toContain("담당자 메모");
  });
});

describe("파트너스 메일 바닥글: 빈 항목은 뺀다", () => {
  it("플랫폼 정보가 비면 줄에서 그 항목만 빠지고 값을 지어내지 않는다", () => {
    const input = { platform: { name: "", representative: "", businessNumber: "", address: "", phone: "", url: "onq.example" }, representative: "a", shopName: "b", statusUrl: "https://x.example/s", kind: "SUPPLEMENT" as const, reason: "r", daysLeft: 3 };
    const none = partnerRejectedMail(input).text;
    expect(none).not.toMatch(/상호|사업자등록번호|고객센터/);
    expect(none).toContain("이 메일은 발신 전용이에요");
    const some = partnerRejectedMail({ ...input, platform: { ...input.platform, name: "온큐", phone: "1588-0000" } }).text;
    expect(some).toContain("상호 온큐 · 고객센터 1588-0000");
  });
});

describe("안전·서식 도우미", () => {
  it("값은 HTML로 이스케이프하고 위험한 링크·색은 막는다", () => {
    const evil = '<script>alert(1)</script>"><img src=x onerror=1>';
    const m = orderCompletedMail({ ...base, brand: { ...brand, shopName: evil, color: "red;background:url(javascript:1)" }, nickname: evil, orderUrl: "javascript:alert(1)", payment: "CARD", paymentLabel: evil, receiver: { ...receiver, memo: evil }, lines: [{ name: evil, quantity: 1, amount: 1000 }] });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toMatch(/<img/);
    expect(m.html).not.toContain("javascript:");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain('href="#"');
    expect(m.html).toContain("#5b3df6"); // 잘못된 색은 기본 색으로
    expect(safeColor("#ABCDEF")).toBe("#abcdef");
    expect(safeColor("#abc")).toBe("#5b3df6");
    expect(safeUrl("https://ok.example/a?b=1")).toBe("https://ok.example/a?b=1");
    expect(safeUrl("http://x/\" onclick=\"y")).toBe("#");
    expect(safeUrl("data:text/html,x")).toBe("#");
  });
  it("밝은 쇼핑몰 색이면 어두운 글자, 어두우면 흰 글자", () => {
    const light = orderCompletedMail({ ...base, brand: { ...brand, color: "#ffe14d" }, payment: "CARD", paymentLabel: "카드", receiver });
    expect(light.html).toMatch(/background:#ffe14d;color:#1b1b1f/);
    expect(all[0][1].html).toMatch(/background:#5b3df6;color:#ffffff/);
  });
  it("날짜·금액 표기(KST)", () => {
    expect(dateTime(new Date("2026-10-02T11:41:00Z"))).toBe("2026.10.02 20:41");
    expect(dateTime(new Date("2026-10-02T15:05:00Z"))).toBe("2026.10.03 00:05");
    expect(dateDay(new Date("2026-10-05T03:00:00Z"))).toBe("2026.10.05 (월)");
    expect(deadline(new Date("2026-10-03T11:41:00Z"))).toBe("10월 3일 (토) 오후 8시 41분");
    expect(deadline(new Date("2026-10-03T03:05:00Z"))).toBe("10월 3일 (토) 오후 12시 05분");
    expect(won(300200)).toBe("300,200원");
    expect(signedWon(-10000)).toBe("−10,000원");
  });
});
