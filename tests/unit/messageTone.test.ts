import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_MESSAGES } from "../../lib/server/auth/account";
import { BUYER_LOGIN_ERROR_MESSAGES, LOGIN_ERROR_MESSAGES, loginErrorBody } from "../../lib/server/auth/messages";
import { RECOVERY_LIMIT_MESSAGE } from "../../lib/server/auth/recoveryFlow";
import { MEMBER_POLICY_MESSAGES } from "../../lib/server/buyers/rejoin";
import { MAINTENANCE_MESSAGES, MAINTENANCE_NOTICE, MAINTENANCE_NOTICE_FORMAL } from "../../lib/server/maintenance/service";
import { START_IN_PROGRESS_MESSAGE, START_IN_PROGRESS_MESSAGE_FORMAL } from "../../lib/server/identity/attempt";
import { purposeTone } from "../../lib/server/identity/http";
import { IDENTITY_ERROR_MESSAGES, identityErrorBody } from "../../lib/server/identity/messages";
import { ORDER_ERROR_MESSAGES, ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { STAFF_LINK_MESSAGES } from "../../lib/server/sellers/staffIdentityFlow";
import { SHARE_PREVIEW_MESSAGES } from "../../lib/server/shop/sharePreview";
import { SHOP_IMAGE_MESSAGES } from "../../lib/server/shop-content/image";
import { LOGO_MESSAGES } from "../../lib/server/shop-content/logo";
import { CONTENT_MESSAGES } from "../../lib/server/shop-content/service";
import { COUPON_MESSAGES } from "../../lib/server/shop-coupons/rules";
import { SHOP_LEGAL_MESSAGES } from "../../lib/server/shop-legal/service";
import { BUYER_COUPON_MESSAGES, CODE_MESSAGES, ORDER_COUPON_MESSAGES } from "../../lib/server/shop-coupons/service";
import { BUYER_REVIEW_MESSAGES, SELLER_REVIEW_MESSAGES } from "../../lib/server/product-reviews/service";

// 서버 응답 문구 말투(lib/server/text/tone.ts): 파트너스·마스터 관리자 API는 합니다체, 구매자·공개 API와 파트너스 가입 신청은 해요체.
const FRIENDLY = /(요|요\.|요\?)$/;
const formal = (m: string) => expect(m, m).not.toMatch(FRIENDLY);
const friendly = (m: string) => expect(m, m).not.toMatch(/(니다|십시오)/);

describe("문구표 말투", () => {
  it("합니다체 표에는 해요체 문장이 없고, 해요체 표에는 합니다체 문장이 없다", () => {
    for (const m of [
      ...Object.values(LOGIN_ERROR_MESSAGES),
      loginErrorBody("account_disabled", "admin").message,
      ...Object.values(ORDER_ERROR_MESSAGES_FORMAL),
      ...Object.keys(IDENTITY_ERROR_MESSAGES).map((c) => identityErrorBody(c as keyof typeof IDENTITY_ERROR_MESSAGES, "formal").message),
      START_IN_PROGRESS_MESSAGE_FORMAL,
      RECOVERY_LIMIT_MESSAGE,
      ...Object.values(STAFF_LINK_MESSAGES),
      ...Object.values(MEMBER_POLICY_MESSAGES),
      ...Object.values(SHARE_PREVIEW_MESSAGES),
      // 배너·팝업·이미지·로고(app/api/seller/shop-content/**). 구매자 쪽 shop-content API는 문구를 내려주지 않는다.
      ...Object.values(CONTENT_MESSAGES),
      ...Object.values(SHOP_IMAGE_MESSAGES),
      ...Object.values(LOGO_MESSAGES),
      // 쿠폰·리뷰 파트너스 관리자 문구
      ...Object.values(COUPON_MESSAGES),
      ...Object.values(SELLER_REVIEW_MESSAGES),
      // 점검 모드: 마스터 관리자 문구, 파트너스 API 점검 중 기본 문구
      ...Object.values(MAINTENANCE_MESSAGES),
      // 쇼핑몰 이용약관·개인정보처리방침 입력(파트너스 관리자)
      ...Object.values(SHOP_LEGAL_MESSAGES),
      // 내 계정(비밀번호·이름) 파트너스·마스터 관리자
      ...Object.values(ACCOUNT_MESSAGES),
      MAINTENANCE_NOTICE_FORMAL,
    ])
      formal(m);
    for (const m of [
      ...Object.values(BUYER_LOGIN_ERROR_MESSAGES),
      ...Object.values(ORDER_ERROR_MESSAGES),
      ...Object.values(IDENTITY_ERROR_MESSAGES),
      START_IN_PROGRESS_MESSAGE,
      // 쿠폰·리뷰 구매자 문구
      ...Object.values(BUYER_COUPON_MESSAGES),
      ...Object.values(CODE_MESSAGES),
      ...Object.values(ORDER_COUPON_MESSAGES),
      ...Object.values(BUYER_REVIEW_MESSAGES),
      MAINTENANCE_NOTICE,
    ])
      friendly(m);
    // 두 벌은 같은 사유를 모두 가진다
    expect(Object.keys(ORDER_ERROR_MESSAGES_FORMAL).sort()).toEqual(Object.keys(ORDER_ERROR_MESSAGES).sort());
    expect(Object.keys(LOGIN_ERROR_MESSAGES).sort()).toEqual(Object.keys(BUYER_LOGIN_ERROR_MESSAGES).sort());
  });

  it("본인확인 용도별 말투: 구매자 가입·파트너스 가입 신청은 해요체, 그 밖(파트너스 계정 찾기·직원 연결)은 합니다체", () => {
    expect(purposeTone("BUYER_SIGNUP")).toBe("friendly");
    expect(purposeTone("SELLER_REPRESENTATIVE")).toBe("friendly");
    expect(purposeTone("PASSWORD_RESET")).toBe("formal");
    expect(purposeTone("ACCOUNT_RECOVERY")).toBe("formal");
    expect(purposeTone("STAFF_LINK")).toBe("formal");
  });
});

// 경로 목록 검사: 관리자 API는 공용 문구 함수를 합니다체로 부르고, 구매자·공개 API와 파트너스 가입 신청은 해요체(기본값)로 부른다.
const API = join(__dirname, "../../app/api");
const routes = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routes(p) : n === "route.ts" ? [relative(API, p)] : [];
  });
const CALLS = /(orderErrorBody|identityFailure|identityUnavailable)\(([^()]*)\)/g;

describe("API 대상별 말투", () => {
  it("app/api/seller·admin은 \"formal\", 그 밖은 기본값(해요체)으로 부른다", () => {
    for (const r of routes(API)) {
      const admin = r.startsWith("seller/") || r.startsWith("admin/");
      const src = readFileSync(join(API, r), "utf8");
      for (const [call, , args] of src.matchAll(CALLS)) {
        if (admin) expect(args, `${r}: ${call}`).toMatch(/"formal"$/);
        else expect(args, `${r}: ${call}`).not.toMatch(/"formal"/);
      }
      if (admin) expect(src, r).not.toMatch(/\bSTART_IN_PROGRESS_MESSAGE\b/);
    }
  });
});
