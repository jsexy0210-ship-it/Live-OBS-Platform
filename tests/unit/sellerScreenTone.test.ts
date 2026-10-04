import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 파트너스 관리자 화면 문구 말투(CLAUDE.md 2026-10-04): 버튼·라벨은 명사형, 문장은 합니다체. 해요체 어미(「~요」)를 화면 소스에서 잡는다.
// 제외: 파트너스 가입 신청(signup, 공개 화면이라 해요체), 공개·관리자 두 말투를 함께 가진 공용 파일(말투표는 messageTone.test.ts가 본다).
const ROOT = join(__dirname, "../..");
const DIRS = ["app/(seller)/seller", "components/seller"];
const EXCLUDE = [
  "app/(seller)/seller/signup/",
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
  it("화면 소스에 해요체 문장이 없다", () => {
    const found: string[] = [];
    for (const dir of DIRS) {
      for (const file of files(join(ROOT, dir))) {
        const rel = relative(ROOT, file).split("\\").join("/");
        if (EXCLUDE.some((x) => rel.startsWith(x))) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.trim();
            if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("{/*")) return;
            const text = line.replace(/\/\/.*$/, "");
            if (!FRIENDLY.test(text) || ALLOW.some((a) => text.includes(a))) return;
            found.push(`${rel}:${i + 1}: ${code}`);
          });
      }
    }
    expect(found).toEqual([]);
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
