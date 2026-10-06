"use client";

import { useCallback, useEffect, useState } from "react";
import { api, failMessage } from "../../../../../../components/seller/api";
import type { OnSection } from "./sectionSave";

// SA-060 ③ 사업자·고객센터(쇼핑몰 설정 권한이 있는 계정에만 보임, 정본 v313의 4열 표). SA-062 「사업자 정보·고지」 탭과 같은 저장 값·같은 API(GET·PUT /api/seller/shop-legal-notice)를 쓴다.
// 상호·대표자·사업자등록번호·통신판매업 신고번호는 입점 신청 때 받은 검증 값이라 읽기 전용. 주소·고객센터 전화·운영시간은 페이지의 「저장」으로 저장한다(나머지 고지 항목은 서버에 있는 값 그대로 다시 보낸다).
// 카카오톡·유튜브 채널 주소(https만)는 같은 API로 저장하고, 입력하면 구매자 바닥글에 「카카오톡 문의」 · 「유튜브 채널」이 보인다.
type Notice = { address: string; csPhone: string; csEmail: string; csHours: string; kakaoChannelUrl: string; youtubeChannelUrl: string; escrowKind: string; escrowProvider: string; escrowUrl: string; minorNotice: string; version: number };
type Business = { companyName: string | null; representativeName: string | null; businessNumber: string | null; mailOrderNumber: string | null };
type Loaded = { notice: Notice; business: Business };

const ADDRESS_MAX = 200;
const HOURS_MAX = 100;
const PHONE = /^[0-9+\-() ]{5,30}$/;
const bizNo = (v: string | null) => (v && /^\d{10}$/.test(v) ? `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}` : v);
// 입력 예시(placeholder): 정본 v336 placeholders.md 문구
const PLACEHOLDER: Record<string, string> = {
  "biz-phone": "02-000-0000",
  "biz-hours": "평일 10:00 ~ 18:00",
  "biz-kakao": "카카오톡 채널 주소",
  "biz-youtube": "유튜브 채널 주소",
  "biz-address": "주소 검색",
};
const len = (v: string) => [...v.trim()].length;
const URL_MAX = 300;
// 채널 주소는 https://로 시작하는 주소만(서버 기준, 비우면 지운다)
const httpsOk = (v: string) => {
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".");
  } catch {
    return false;
  }
};
const urlError = (v: string, label: string) => (v.trim() && (v.trim().length > URL_MAX || !httpsOk(v)) ? `${label}는 https://로 시작하는 주소만 쓸 수 있습니다` : null);

export function BusinessSection({ onSection, disabled }: { onSection: OnSection; disabled: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [address, setAddress] = useState("");
  const [csPhone, setCsPhone] = useState("");
  const [csHours, setCsHours] = useState("");
  const [kakao, setKakao] = useState("");
  const [youtube, setYoutube] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  const apply = (d: Loaded) => {
    setData(d);
    setAddress(d.notice.address);
    setCsPhone(d.notice.csPhone);
    setCsHours(d.notice.csHours);
    setKakao(d.notice.kakaoChannelUrl ?? "");
    setYoutube(d.notice.youtubeChannelUrl ?? "");
  };
  const load = useCallback(async () => {
    const r = await api<Loaded>("/api/seller/shop-legal-notice");
    if (!r.ok) return setFailed(true);
    setFailed(false);
    apply(r.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saved = data?.notice;
  const dirty = !!saved && (saved.address !== address || saved.csPhone !== csPhone || saved.csHours !== csHours || (saved.kakaoChannelUrl ?? "") !== kakao || (saved.youtubeChannelUrl ?? "") !== youtube);
  // 필수 칸은 이 구역을 고칠 때만 막는다(서버는 빈 값도 받으므로, 손대지 않은 기존 값 때문에 다른 구역 저장이 막히지 않게)
  const phoneError = !csPhone.trim() ? "고객센터 연락처를 입력해 주십시오" : !PHONE.test(csPhone.trim()) ? "전화번호는 숫자·하이픈·괄호만 입력할 수 있습니다" : null;
  const hoursError = len(csHours) > HOURS_MAX ? `운영 시간은 ${HOURS_MAX}자까지 입력할 수 있습니다` : null;
  const kakaoError = urlError(kakao, "카카오톡 채널 주소");
  const youtubeError = urlError(youtube, "유튜브 채널 주소");
  const addressError = !address.trim() ? "사업장 주소를 입력해 주십시오" : len(address) > ADDRESS_MAX ? `주소는 ${ADDRESS_MAX}자까지 입력할 수 있습니다` : null;

  // 렌더마다 최신 핸들을 페이지에 넘긴다(부모의 상태 갱신은 렌더 중이 아니라 효과에서 한다)
  useEffect(() => onSection("business", {
    label: "사업자 · 고객센터",
    dirty,
    validate: () => {
      if (!dirty) return true;
      setShowErrors(true);
      return !phoneError && !hoursError && !addressError && !kakaoError && !youtubeError;
    },
    reset: () => {
      if (saved) (setAddress(saved.address), setCsPhone(saved.csPhone), setCsHours(saved.csHours), setKakao(saved.kakaoChannelUrl ?? ""), setYoutube(saved.youtubeChannelUrl ?? ""));
      setShowErrors(false);
    },
    save: async () => {
      if (!saved || !dirty) return null;
      const { version, ...rest } = saved;
      const r = await api<Loaded>("/api/seller/shop-legal-notice", { method: "PUT", body: { ...rest, address, csPhone, csHours, kakaoChannelUrl: kakao.trim(), youtubeChannelUrl: youtube.trim(), expectedVersion: version } });
      if (!r.ok) return r.error === "version_conflict" ? "다른 곳에서 먼저 바뀌었습니다. 새로고침한 뒤 다시 저장해 주십시오" : failMessage(r, "admin", "저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오");
      apply(r.data);
      setShowErrors(false);
      return null;
    },
  }));

  if (failed) {
    return (
      <section className="au-fs" style={{ marginTop: 32 }}>
        <div className="au-fs-h">
          <h2 className="au-fs-t">사업자 · 고객센터</h2>
        </div>
        <span className="err" role="alert">사업자 · 고객센터를 불러오지 못했습니다</span>{" "}
        <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>다시 시도</button>
      </section>
    );
  }
  if (!data) return null;
  const biz = data.business;
  const readonly = (v: string | null, placeholder: string) => <input className="inp" value={v ?? ""} placeholder={placeholder} readOnly aria-readonly style={{ width: "100%" }} />;
  const field = (id: string, v: string, set: (v: string) => void, error: string | null, help?: string) => (
    <>
      <input id={id} placeholder={PLACEHOLDER[id]} className={`inp${showErrors && error ? " is-error" : ""}`} value={v} onChange={(e) => set(e.target.value)} style={{ width: "100%" }} aria-invalid={showErrors && !!error} disabled={disabled} />
      {showErrors && error ? <span className="err" role="alert">{error}</span> : help && <p className="help au-ft-help">{help}</p>}
    </>
  );

  return (
    <section className="au-fs" style={{ marginTop: 32 }} data-testid="business-section">
      <div className="au-fs-h">
        <h2 className="au-fs-t">사업자 · 고객센터</h2>
        <span className="t-l2 c-alt">쇼핑몰 하단과 주문서에 표시됩니다 (전자상거래법)</span>
      </div>
      <table className="au-ft si-ft4">
        <colgroup>
          <col style={{ width: 160 }} />
          <col />
          <col style={{ width: 160 }} />
          <col />
        </colgroup>
        <tbody>
          <tr>
            <th scope="row"><span className="req">상호</span></th>
            <td className="si-rt" data-testid="biz-company">{readonly(biz.companyName, "사업자등록증의 상호")}</td>
            <th scope="row"><span className="req">대표자</span></th>
            <td>{readonly(biz.representativeName, "대표자 이름")}</td>
          </tr>
          <tr>
            <th scope="row"><span className="req">사업자등록번호</span></th>
            <td className="si-rt">{readonly(bizNo(biz.businessNumber), "000-00-00000")}<p className="help au-ft-help">가입 심사 때 확인 · 변경은 문의</p></td>
            <th scope="row"><span className="req">통신판매업 신고번호</span></th>
            <td>{readonly(biz.mailOrderNumber, "통신판매업 신고번호")}</td>
          </tr>
          <tr>
            <th scope="row"><label htmlFor="biz-phone" className="req">고객센터 연락처</label></th>
            <td className="si-rt">{field("biz-phone", csPhone, setCsPhone, phoneError)}</td>
            <th scope="row"><label htmlFor="biz-hours">운영 시간</label></th>
            <td>{field("biz-hours", csHours, setCsHours, hoursError)}</td>
          </tr>
          <tr>
            <th scope="row"><label htmlFor="biz-kakao">카카오톡 채널 주소</label></th>
            <td className="si-rt">
              {field("biz-kakao", kakao, setKakao, kakaoError, "입력하면 하단에 「카카오톡 문의」 버튼")}
            </td>
            <th scope="row"><label htmlFor="biz-youtube">유튜브 채널 주소</label></th>
            <td>
              {field("biz-youtube", youtube, setYoutube, youtubeError)}
            </td>
          </tr>
          <tr>
            <th scope="row"><label htmlFor="biz-address" className="req">사업장 주소</label></th>
            <td colSpan={3}>{field("biz-address", address, setAddress, addressError)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
