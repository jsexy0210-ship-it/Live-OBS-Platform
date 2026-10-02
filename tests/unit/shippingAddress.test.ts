import { describe, expect, it } from "vitest";
import { DEFAULT_SHIPPING_POLICY, isRemoteAddress, parseShippingAddress } from "../../lib/server/orders/shipping";

const remote = (address1: string, zip = "06236") => isRemoteAddress(zip, address1, DEFAULT_SHIPPING_POLICY.remoteZipRanges);
const base = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

describe("도서산간 주소 판정(우편번호가 범위 밖이어도)", () => {
  it("앞머리 기호·폭 없는 공백·나라 이름·괄호·NFD·영문 표기를 거쳐도 첫 행정구역이 제주·울릉이면 도서산간", () => {
    for (const a of [
      "\u200b제주시 첨단로 1",
      "대한민국 제주특별자치도 제주시 첨단로 1",
      "(제주) 제주시 첨단로 1",
      "[제주특별자치도] 서귀포시 중앙로 1",
      "Jeju-si, Jeju-do",
      "1 Cheomdan-ro, Jeju-si, Jeju Special Self-Governing Province",
      "123 Jungang-ro, Seogwipo-si",
      "Ulleung-gun, Gyeongsangbuk-do",
      "제주시".normalize("NFD") + " 첨단로 1",
      "제주특별자치도 제주시 첨단로 1".normalize("NFD"),
      "제주도 서귀포시 1",
      "서귀포시 중앙로 1",
      "경상북도 울릉군 울릉읍 도동길 1",
      "대한민국 경북 울릉군 1",
      "울릉도 1",
      "63100 제주시 1",
      // 붙여 쓴 주소(#79 1차 회귀)
      "경상북도울릉군 울릉읍 1",
      "제주특별자치도제주시 첨단로 1",
      "제주특별자치도서귀포시 1",
    ]) {
      expect(remote(a), a).toBe(true);
    }
  });

  it("도로명·건물명에 든 지명, 다른 지역은 도서산간이 아니다", () => {
    for (const a of [
      "서울 강남구 제주로 1",
      "대한민국 서울특별시 제주로 1",
      "경상북도 포항시 울릉로 1",
      "부산 해운대구 제주빌딩 1",
      "1 Jeju-ro, Gangnam-gu, Seoul",
      "제주로 1",
      "대구 동구 울릉길 1",
    ]) {
      expect(remote(a), a).toBe(false);
    }
  });

  it("우편번호 범위 안이면 주소와 상관없이 도서산간", () => {
    expect(remote("서울 강남구 1", "63000")).toBe(true);
    expect(remote("서울 강남구 1", "40240")).toBe(true);
  });
});

describe("배송지 입력의 보이지 않는 문자", () => {
  it("한글 채움 문자는 받는 분·주소에서 거부(채움 문자만 있는 이름 포함)", () => {
    for (const f of ["\u3164", "\u115f", "\u1160", "\uffa0"]) {
      expect(parseShippingAddress({ ...base, recipientName: f }), JSON.stringify(f)).toBeNull();
      expect(parseShippingAddress({ ...base, recipientName: `김${f}` }), JSON.stringify(f)).toBeNull();
      expect(parseShippingAddress({ ...base, address1: `서울${f}강남구` }), JSON.stringify(f)).toBeNull();
      expect(parseShippingAddress({ ...base, address2: f }), JSON.stringify(f)).toBeNull();
    }
  });

  it("메모는 ZWJ·변형 선택자가 든 이모지를 받고, 이름·주소에서는 거부", () => {
    const family = "👨\u200d👩\u200d👧";
    const heart = "❤\ufe0f";
    expect(parseShippingAddress({ ...base, memo: `문 앞 ${family}${heart}` })).toMatchObject({ memo: `문 앞 ${family}${heart}` });
    expect(parseShippingAddress({ ...base, recipientName: `김${family}` })).toBeNull();
    // 메모라도 방향 바꿈·폭 없는 공백은 거부
    expect(parseShippingAddress({ ...base, memo: "문 앞\u202e" })).toBeNull();
    expect(parseShippingAddress({ ...base, memo: "문 앞\u200b" })).toBeNull();
  });

  it("짝 없는 서로게이트·사용자 정의 문자·점자 빈칸·결합 문자만 있는 이름·주소는 거부(상품과 같은 규칙)", () => {
    for (const bad of ["김\ud800", "김\ue000", "\u2800", "김\u2800구매", "\u0301"]) {
      expect(parseShippingAddress({ ...base, recipientName: bad }), JSON.stringify(bad)).toBeNull();
      expect(parseShippingAddress({ ...base, address1: bad }), JSON.stringify(bad)).toBeNull();
    }
    expect(parseShippingAddress({ ...base, memo: "문 앞\ud800" })).toBeNull();
  });

  it("메모는 서버가 아직 모르는 최신 이모지(미할당 판정)·지역 깃발 태그 문자를 받고, 이름·주소는 거부", () => {
    const newEmoji = "\u{1faea}";
    const scotland = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}";
    expect(parseShippingAddress({ ...base, memo: `문 앞 ${newEmoji}` })).toMatchObject({ memo: `문 앞 ${newEmoji}` });
    expect(parseShippingAddress({ ...base, memo: newEmoji })).toMatchObject({ memo: newEmoji });
    expect(parseShippingAddress({ ...base, memo: `문 앞 ${scotland}` })).toMatchObject({ memo: `문 앞 ${scotland}` });
    expect(parseShippingAddress({ ...base, recipientName: `김${newEmoji}` })).toBeNull();
    expect(parseShippingAddress({ ...base, address1: `서울 ${scotland}` })).toBeNull();
    // 메모라도 서로게이트·사용자 정의·제어·방향 문자는 거부
    for (const bad of ["\ud800", "\ue000", "\u0000", "\u202e"]) {
      expect(parseShippingAddress({ ...base, memo: `문 앞${bad}` }), JSON.stringify(bad)).toBeNull();
    }
  });

  it("연락처·우편번호는 전각 숫자·하이픈도 정규화해 받는다", () => {
    expect(parseShippingAddress({ ...base, phone: "０１０－１２３４－５６７８", zipCode: "０６２３６" })).toMatchObject({ phone: "01012345678", zipCode: "06236" });
  });

  it("방향 바꿈(RLO 등)·폭 없는 문자·줄·문단 구분 문자·제어문자는 거부", () => {
    for (const bad of ["\u202e", "\u2066", "\u200b", "\u200d", "\ufeff", "\u00ad", "\u2028", "\u2029", "\u0000", "\n", "\u0085"]) {
      expect(parseShippingAddress({ ...base, recipientName: `김${bad}구매` }), JSON.stringify(bad)).toBeNull();
      expect(parseShippingAddress({ ...base, address1: `서울${bad} 강남구` }), JSON.stringify(bad)).toBeNull();
      expect(parseShippingAddress({ ...base, address2: `101${bad}호` }), JSON.stringify(bad)).toBeNull();
      // 메모는 이모지용 ZWJ만 허용(아래 테스트)
      if (bad !== "\u200d") expect(parseShippingAddress({ ...base, memo: `문 앞${bad}` }), JSON.stringify(bad)).toBeNull();
    }
  });

  it("전각 공백·NBSP는 정규화해 일반 공백으로 받고, NFD는 합쳐서 저장한다", () => {
    const r = parseShippingAddress({ ...base, recipientName: "김　구매", address1: "서울 강남구 테헤란로 1", address2: "101호".normalize("NFD") });
    expect(r).toMatchObject({ recipientName: "김 구매", address1: "서울 강남구 테헤란로 1", address2: "101호" });
  });
});
