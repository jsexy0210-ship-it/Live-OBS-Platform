"use client";

import { useCallback, useEffect, useState } from "react";
import { FormRow, FormSection } from "../../../../../../components/admin-ui";
import { api, failMessage } from "../../../../../../components/seller/api";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";

// SA-060 ③ 사업자·고객센터(쇼핑몰 설정 권한이 있는 계정에만 보임). SA-062 「사업자 정보·고지」 탭과 같은 저장 값·같은 API(GET·PUT /api/seller/shop-legal-notice)를 쓴다.
// 상호·대표자·사업자등록번호·통신판매업 신고번호는 입점 신청 때 받은 검증 값이라 읽기 전용. 주소·고객센터 전화·운영시간만 여기서 바꾼다(나머지 고지 항목은 서버에 있는 값 그대로 보낸다).
type Notice = { address: string; csPhone: string; csEmail: string; csHours: string; escrowKind: string; escrowProvider: string; escrowUrl: string; minorNotice: string; version: number };
type Business = { companyName: string | null; representativeName: string | null; businessNumber: string | null; mailOrderNumber: string | null };
type Loaded = { notice: Notice; business: Business };

const ADDRESS_MAX = 200;
const HOURS_MAX = 100;
const PHONE = /^[0-9+\-() ]{5,30}$/;
const bizNo = (v: string | null) => (v && /^\d{10}$/.test(v) ? `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}` : v);
const len = (v: string) => [...v.trim()].length;

export function BusinessSection({ onToast }: { onToast: (t: string) => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [address, setAddress] = useState("");
  const [csPhone, setCsPhone] = useState("");
  const [csHours, setCsHours] = useState("");
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const apply = (d: Loaded) => {
    setData(d);
    setAddress(d.notice.address);
    setCsPhone(d.notice.csPhone);
    setCsHours(d.notice.csHours);
  };
  const load = useCallback(async () => {
    const r = await api<Loaded>("/api/seller/shop-legal-notice");
    if (!r.ok) return setFailed(true);
    setFailed(false);
    setFailure(null);
    setConflict(false);
    apply(r.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saved = data?.notice;
  const dirty = !!saved && (saved.address !== address || saved.csPhone !== csPhone || saved.csHours !== csHours);
  useUnsavedGuard(dirty);

  const phoneError = csPhone.trim() && !PHONE.test(csPhone.trim()) ? "전화번호는 숫자·하이픈·괄호만 입력할 수 있습니다" : null;
  const hoursError = len(csHours) > HOURS_MAX ? `운영시간은 ${HOURS_MAX}자까지 입력할 수 있습니다` : null;
  const addressError = len(address) > ADDRESS_MAX ? `주소는 ${ADDRESS_MAX}자까지 입력할 수 있습니다` : null;

  const save = async () => {
    if (!saved || saving) return;
    setShowErrors(true);
    if (phoneError || hoursError || addressError) return;
    setSaving(true);
    setFailure(null);
    setConflict(false);
    const { version, ...rest } = saved;
    const r = await api<Loaded>("/api/seller/shop-legal-notice", { method: "PUT", body: { ...rest, address, csPhone, csHours, expectedVersion: version } });
    setSaving(false);
    if (!r.ok) {
      if (r.error === "version_conflict") setConflict(true);
      return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오"));
    }
    apply(r.data);
    setShowErrors(false);
    onToast("사업자·고객센터를 저장했습니다 · 구매자 바닥글에 반영");
  };

  if (failed) {
    return (
      <div style={{ marginTop: 32 }}>
        <FormSection title="사업자 · 고객센터">
          <FormRow label="사업자 · 고객센터">
            <span className="err" role="alert">사업자 · 고객센터를 불러오지 못했습니다</span>
            <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>다시 시도</button>
          </FormRow>
        </FormSection>
      </div>
    );
  }
  if (!data) return null;
  const biz = data.business;
  const text = (label: string, id: string, value: string, set: (v: string) => void, error: string | null | undefined, width: number, help?: string) => (
    <FormRow label={label} htmlFor={id} help={help}>
      <input id={id} className={`inp${showErrors && error ? " is-error" : ""}`} value={value} onChange={(e) => set(e.target.value)} style={{ width, maxWidth: "100%" }} aria-invalid={showErrors && !!error} disabled={saving} />
      {showErrors && error && <span className="err" role="alert">{error}</span>}
    </FormRow>
  );

  return (
    <div style={{ marginTop: 32 }} data-testid="business-section">
      <FormSection title="사업자 · 고객센터" actions={<span className="t-l2 c-alt">쇼핑몰 하단과 주문서에 표시됩니다 (전자상거래법)</span>}>
        <FormRow label="상호" help="입점 신청 때 확인한 값입니다 · 변경은 문의해 주십시오"><b data-testid="biz-company">{biz.companyName ?? "-"}</b></FormRow>
        <FormRow label="대표자"><b>{biz.representativeName ?? "-"}</b></FormRow>
        <FormRow label="사업자등록번호"><b>{bizNo(biz.businessNumber) ?? "-"}</b></FormRow>
        <FormRow label="통신판매업 신고번호"><b>{biz.mailOrderNumber ?? "-"}</b></FormRow>
        {text("고객센터 연락처", "biz-phone", csPhone, setCsPhone, phoneError, 280, "예: 1588-1234")}
        {text("운영 시간", "biz-hours", csHours, setCsHours, hoursError, 280, "예: 평일 10:00~17:00")}
        {text("사업장 주소", "biz-address", address, setAddress, addressError, 520)}
        {failure && (
          <FormRow label="저장">
            <span className="err" role="alert">{failure}</span>
            {conflict && <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>최신 내용 불러오기</button>}
          </FormRow>
        )}
        <FormRow label="" help="법정 고지 · 약관의 「사업자 정보·고지」 탭과 같은 값입니다">
          <button className="btn btn-sm" type="button" disabled={saving || !dirty} onClick={() => void save()} data-testid="biz-save">{saving ? "저장 중" : "사업자·고객센터 저장"}</button>
        </FormRow>
      </FormSection>
    </div>
  );
}
