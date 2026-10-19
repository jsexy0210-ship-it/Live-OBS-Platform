import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 파트너스 관리자 화면 문구 말투: 승인된 홈 3파일과 2026-10-18 승인된 신규 조회 상태·외부 쇼핑몰 안내 문구만 해요체다.
// 제외: 파트너스 가입 신청(signup, 공개 화면이라 해요체), 공개·관리자 두 말투를 함께 가진 공용 파일(말투표는 messageTone.test.ts가 본다).
const ROOT = join(__dirname, "../..");
const DIRS = ["app/(seller)/seller", "components/seller"];
// 디렉터리 예외로 넓히지 않고 승인된 파일과 대표 화면 문구를 함께 고정한다.
const APPROVED_HOME_COPY = {
  "components/seller/home/UnifiedHome.tsx": [
    "의 운영 현황과 방송을 한곳에서 확인해요.",
    "방송을 끝낼까요?",
  ],
  "components/seller/home/HomeDashboard.tsx": [
    "처리할 일을 불러오지 못했어요",
    "지금 처리할 일이 없어요",
  ],
  "components/seller/broadcast/YoutubeLivePlayer.tsx": [
    "유튜브 연결을 불러오고 있어요.",
    "연결된 유튜브 방송이 없어요. 유튜브 연결에서 방송을 선택해 주세요.",
  ],
};
const APPROVED_HOME_FILES = new Set(Object.keys(APPROVED_HOME_COPY));
// 조회 상태는 파일 전체를 제외하지 않고 승인된 문구만 정확히 구분한다.
const APPROVED_READ_COPY: Record<string, readonly string[]> = {
  "app/(seller)/seller/(shell)/overlay/address/page.tsx": [
    "주소 정보를 불러오지 못했어요. 이전 정보를 보여드려요.",
    "주소 정보를 불러오지 못했어요",
    "주소 정보를 불러오고 있어요.",
  ],
  "app/(seller)/seller/(shell)/settings/shop/page.tsx": [
    "쇼핑몰 설정을 불러오고 있어요.",
    "쇼핑몰 설정을 불러오지 못했어요.",
  ],
};
// 외부 쇼핑몰은 별도 승인 범위이며 파일 전체를 제외하지 않는다.
const APPROVED_EXTERNAL_COPY: Record<string, readonly string[]> = {
  "app/(seller)/seller/(shell)/external-shops/page.tsx": [
    "연결한 쇼핑몰의 주문이 들어오고 있어요",
    "허용이 풀려 주문 알림이 멈췄어요 · 다시 연결해 주세요",
    "연결을 끊고 있어요 · 쇼핑몰 응답을 기다리는 중에는 주문을 받지 않아요 · 끝나면 「끊어짐」",
    "허용이 풀려 주문 알림이 멈췄어요",
    "아직 받은 주문 알림이 없어요",
    "연결한 쇼핑몰의 주문 알림이 주문대기와 방송 화면으로 들어와요 · 플랫폼 이름은 표시하지 않아요",
    "쇼핑몰 앱 권한이 바뀌거나 만료되면 다시 연결해야 해요 · 끊는 중에는 쇼핑몰 응답을 기다려요. 그동안 주문은 받지 않아요",
    "대표자와 「쇼핑몰 설정」 권한이 있는 직원만 연결 · 해제할 수 있어요 · 목록 조회도 같은 권한이 필요해요",
  ],
};
// 결과 미확인 조정의 복구·새 요청 구분에 승인된 문구만 허용한다.
const APPROVED_ADJUST_COPY: Record<string, readonly string[]> = {
  "app/(seller)/seller/(shell)/rewards/balances/page.tsx": [
    "거절된 요청의 보관 정보를 지우지 못했어요. 화면을 다시 불러와 주세요.",
    "요청 정보를 확인하지 못했어요. 화면을 다시 불러와 주세요.",
    "재시도 정보를 보관하지 못했어요. 원장에서 이전 조정 결과를 확인해 주세요.",
    "조정은 완료됐지만 요청 정보를 정리하지 못했어요. 원장에서 결과를 확인해 주세요.",
    "결과를 확인하지 못한 요청이 있어요. 원장을 확인한 뒤 이전 요청을 재시도하거나 새 조정을 선택해 주세요.",
    "입력 내용이 바뀌었어요. 다시 적용해 주세요.",
    "이전 요청 정보를 찾지 못했어요. 원장에서 결과를 확인해 주세요.",
    "이전 요청을 다시 보낼까요?",
    "새 조정을 보낼까요?",
    "이전 요청이 이미 반영됐다면 같은 금액이 한 번 더 조정될 수 있어요.",
  ],
};
const APPROVED_BULK_COPY: Record<string, readonly string[]> = {
  "app/(seller)/seller/(shell)/products/bulk/page.tsx": [
    "오류 상품은 건너뛰고 반영해요 · 목록에는 앞부분만 보여요 · 새 상품의 상태가 비면 「숨김」으로 등록해요(이미지를 올린 뒤 공개)",
  ],
};
const withoutApprovedCopy = (file: string, text: string) =>
  [...(APPROVED_READ_COPY[file] ?? []), ...(APPROVED_EXTERNAL_COPY[file] ?? []), ...(APPROVED_ADJUST_COPY[file] ?? []), ...(APPROVED_BULK_COPY[file] ?? [])].reduce((remaining, copy) => {
    const escaped = copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return remaining.split(JSON.stringify(copy)).join('""').replace(new RegExp(`(?<=>)\\s*${escaped}\\s*(?=<)`, "g"), "");
  }, text);
const EXCLUDE = [
  "app/(public)/seller/signup/",
  "components/seller/signup/", // 가입 신청 단계 화면 본문(위 signup 화면에서 옮김, 공개 화면이라 해요체)
  "components/seller/api.ts", // failMessage 말투표(admin·public)
  "components/seller/IdentityCheck.tsx", // 본인확인 문구표(admin·public)
  "components/seller/TestModeNotice.tsx", // 파트너스(formal)·구매자 가입 두 말투 문구표
  "components/seller/PartnersAuth.tsx", // 가입·로그인 밖 화면 공용(pub ? 해요체 : 합니다체)
  "components/seller/stepFailure.ts", // RETRY_TEXT_PUBLIC(가입 신청용)
];
// 구매자에게 보이는 예시·미리보기 문구(구매자 화면 말투 = 해요체)
const ALLOW = [
  "매주 금요일 밤 라이브로 만나요", // 공유 미리보기 설명 칸 예시(구매자가 보는 문구)
  "안에 입금하면 주문대기에 올라가요", // 주문 설정의 구매자 화면 미리보기
  "배송이 늦어질 수 있어요", // 상단 공지 입력 예시(구매자 쇼핑몰에 그대로 보이는 해요체 문구)
  "단순 변심으로는 취소 · 환불이 안 돼요", // 이용안내 입력 예시(구매자 해요체)
  "지금은 다시 가입할 수 없어요", // 회원 정책(SA-068) 구매자 안내 미리보기 · 정본 「구매자에게 보이는 안내」 문구(구매자가 보는 말투)
  "지나면 다시 가입할 수 있어요", // 같은 구매자 안내 미리보기의 둘째 줄
  "아니요", // 답변 평가 응답어(SA-115 정본 「도움됨 / 아니요」 버튼 라벨). 문장이 아니라 응답 단어라 해요체 검사에서 뺀다
  "SellerShell 안에서만 써요", // 개발자용 오류(화면에 보이지 않음). SellerShell.tsx는 레이아웃 전담 소유라 그쪽에서 고친다
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|mjs)$/.test(name) ? [p] : [];
  });
}

// 따옴표·백틱 안이나 JSX 글자 끝의 「…요」. 뒤에 붙는 문장부호(. ? ! … ~ 닫는 낫표·따옴표)는 따로 건너뛴다. 주석 줄은 뺀다.
// 「필요」「중요」처럼 요로 끝나는 명사는 뺀다.
const FRIENDLY = /[가-힣](?<![필중주수])요[.?!…~」』”’]*(?=["'`<]|\s*$|\s*\}|\s*·)/;

describe("파트너스 관리자 화면 말투", () => {
  it("승인된 홈 3파일과 신규 조회 상태·외부 쇼핑몰 안내 밖 소스에 해요체 문장이 없다", () => {
    const found: string[] = [];
    for (const dir of DIRS) {
      for (const file of files(join(ROOT, dir))) {
        const rel = relative(ROOT, file).split("\\").join("/");
        if (APPROVED_HOME_FILES.has(rel)) continue;
        if (EXCLUDE.some((x) => rel.startsWith(x))) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.trim();
            if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("{/*")) return;
            const text = line.replace(/\/\/.*$/, "");
            if (!FRIENDLY.test(withoutApprovedCopy(rel, text)) || ALLOW.some((a) => text.includes(a))) return;
            found.push(`${rel}:${i + 1}: ${code}`);
          });
      }
    }
    expect(found).toEqual([]);
  });

  it.each(Object.entries(APPROVED_HOME_COPY))("%s는 승인된 해요체 화면 문구를 유지한다", (file, copies) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const copy of copies) {
      expect(source).toContain(copy);
      expect(FRIENDLY.test(JSON.stringify(copy))).toBe(true);
    }
  });

  it.each(Object.entries({ ...APPROVED_READ_COPY, ...APPROVED_EXTERNAL_COPY, ...APPROVED_ADJUST_COPY, ...APPROVED_BULK_COPY }))("%s는 승인된 신규 문구만 해요체로 허용한다", (file, copies) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const copy of copies) {
      expect(source).toContain(copy);
      expect(FRIENDLY.test(JSON.stringify(copy))).toBe(true);
      expect(FRIENDLY.test(withoutApprovedCopy(file, JSON.stringify(copy)))).toBe(false);
      expect(FRIENDLY.test(withoutApprovedCopy(file, `<span>${copy}</span>`))).toBe(false);
    }
    expect(FRIENDLY.test(withoutApprovedCopy(file, `<span>${copies[0]}</span><span>다른 문구를 추가했어요</span>`))).toBe(true);
    expect(FRIENDLY.test(withoutApprovedCopy(file, `<span>${copies[0]} 다른 문구를 추가했어요</span>`))).toBe(true);
    expect(FRIENDLY.test(withoutApprovedCopy("다른/파일.tsx", JSON.stringify(copies[0])))).toBe(true);
  });

  it("검사기가 해요체를 실제로 잡는다", () => {
    expect(FRIENDLY.test(`<span>저장했어요</span>`)).toBe(true);
    expect(FRIENDLY.test(`setError("다시 시도해 주세요")`)).toBe(true);
    expect(FRIENDLY.test(`"저장할까요?"`)).toBe(true);
    expect(FRIENDLY.test(`"저장했어요!"`)).toBe(true);
    expect(FRIENDLY.test(`"다시 시도해 주세요!"`)).toBe(true);
    expect(FRIENDLY.test(`<span>잠시만요…</span>`)).toBe(true);
    expect(FRIENDLY.test(`"「좋아요」"`)).toBe(true);
    expect(FRIENDLY.test(`{"끝났어요~"}`)).toBe(true);
    expect(FRIENDLY.test(`<span>저장했습니다</span>`)).toBe(false);
    expect(FRIENDLY.test(`"요금제"`)).toBe(false);
    expect(FRIENDLY.test(`["권한 필요", "중요"]`)).toBe(false);
  });
});
