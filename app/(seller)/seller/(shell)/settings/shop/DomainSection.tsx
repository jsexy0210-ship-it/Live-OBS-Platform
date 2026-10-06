"use client";

import { useCallback, useEffect, useState } from "react";
import { FormRow, FormSection, useConfirm } from "../../../../../../components/admin-ui";
import { api, failMessage } from "../../../../../../components/seller/api";
import { formatDateTime } from "../../../../../../lib/client/format";
import type { OnSection } from "./sectionSave";

// SA-060 ③ 내 도메인(쇼핑몰 설정 권한이 있는 계정에만 보임). API: GET·POST /api/seller/domains, POST …/[id]/verify, DELETE …/[id].
// 서버는 등록·DNS 안내·소유 확인(DNS 조회)·해제·상태 표시까지만 한다. 실제 연결(DNS·인증서)은 준비 중이라 그렇게 알린다. 쇼핑몰마다 3개, 확인 전 등록은 7일 뒤 사라진다.
type Dns = { type: string; name: string; value: string };
type Domain = {
  id: string;
  hostname: string;
  status: "PENDING_VERIFICATION" | "VERIFIED" | "SUSPENDED";
  verifiedAt: string | null;
  expiresAt: string | null;
  dns: { verify: Dns; connect: Dns & { a: string | null } };
};
type Listing = { domains: Domain[]; limit: number };

const STATUS_LABEL: Record<Domain["status"], string> = { PENDING_VERIFICATION: "연결 확인 중", VERIFIED: "소유 확인됨", SUSPENDED: "일시 정지" };

export function DomainSection({ onToast, onSection, disabled }: { onToast: (t: string) => void; onSection: OnSection; disabled: boolean }) {
  const { confirm } = useConfirm();
  const [list, setList] = useState<Listing | null>(null);
  const [failed, setFailed] = useState(false);
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<Listing>("/api/seller/domains");
    if (!r.ok) return setFailed(true);
    setFailed(false);
    setList(r.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // 새 주소는 페이지의 「저장」에서 등록한다(확인 창도 페이지 저장 확인 하나). 확인·해제는 줄마다 바로 처리한다.
  useEffect(() =>
    onSection("domain", {
      label: "내 도메인",
      dirty: host.trim() !== "",
      validate: () => true,
      reset: () => (setHost(""), setError(null)),
      save: async () => {
        const hostname = host.trim().toLowerCase();
        if (!hostname) return null;
        const r = await api<{ domain: Domain }>("/api/seller/domains", { method: "POST", body: { hostname } });
        if (!r.ok) {
          const m = failMessage(r, "admin", "추가하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오");
          setError(m);
          return m;
        }
        setHost("");
        setError(null);
        await load();
        return null;
      },
    }),
  );
  const verify = async (d: Domain) => {
    if (busy) return;
    setError(null);
    setBusy(d.id);
    const r = await api<{ verified: boolean }>(`/api/seller/domains/${d.id}/verify`, { method: "POST" });
    setBusy(null);
    if (!r.ok) return setError(failMessage(r, "admin", "확인하지 못했습니다. 잠시 뒤에 다시 눌러 주십시오"));
    onToast(r.data.verified ? "소유 확인이 끝났습니다" : "아직 확인되지 않았습니다 · 설정값을 넣은 뒤 반영까지 보통 10분, 길면 하루가 걸립니다");
    await load();
  };
  const remove = async (d: Domain) => {
    if (busy) return;
    setError(null);
    const ok = await confirm({
      title: `「${d.hostname}」 연결을 해제하시겠습니까?`,
      body: "등록한 주소와 소유 확인 기록이 지워집니다. 다시 연결하려면 처음부터 등록해야 합니다.",
      confirmLabel: "연결 해제",
      danger: true,
    });
    if (!ok) return;
    setBusy(d.id);
    const r = await api<{ ok: true }>(`/api/seller/domains/${d.id}`, { method: "DELETE" });
    setBusy(null);
    if (!r.ok) return setError(failMessage(r, "admin", "해제하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오"));
    onToast("연결을 해제했습니다");
    await load();
  };
  const copy = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v);
      onToast("복사했습니다");
    } catch {
      onToast("복사하지 못했습니다. 값을 직접 선택해 복사해 주십시오");
    }
  };

  if (failed) {
    return (
      <div style={{ marginTop: 32 }}>
        <FormSection title="내 도메인">
          <FormRow label="내 도메인">
            <span className="err" role="alert">
              내 도메인을 불러오지 못했습니다
            </span>
            <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
              다시 시도
            </button>
          </FormRow>
        </FormSection>
      </div>
    );
  }
  if (!list) return null;
  const full = list.domains.length >= list.limit;

  return (
    <div style={{ marginTop: 32 }} data-testid="domain-section">
      <FormSection title="내 도메인" actions={<span className="t-l2 c-alt">기본 주소 외에 내 도메인을 연결합니다</span>}>
        <FormRow label="연결할 주소" htmlFor="domain-host" help={full ? `도메인은 ${list.limit}개까지 연결할 수 있습니다` : `예: shop.example.com · ${list.limit}개까지 · 저장하면 등록되고, 확인하지 않은 주소는 7일 뒤 사라집니다`}>
          <input id="domain-host" className="inp" value={host} onChange={(e) => setHost(e.target.value)} placeholder="shop.example.com" style={{ width: 360 }} disabled={full || busy !== null || disabled} />
          {error && (
            <span className="err" role="alert">
              {error}
            </span>
          )}
        </FormRow>
        {list.domains.map((d) => (
          <FormRow key={d.id} label="내 도메인" help={d.expiresAt ? `확인하지 않으면 ${formatDateTime(d.expiresAt)}에 사라집니다` : d.verifiedAt ? `소유 확인 ${formatDateTime(d.verifiedAt)}` : undefined}>
            <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }} data-testid="domain-row">
              <b>{d.hostname}</b>
              <span className={`t-c1 ${d.status === "VERIFIED" ? "c-pos" : "c-alt"}`}>{STATUS_LABEL[d.status]}</span>
              {d.status === "PENDING_VERIFICATION" && (
                <button className="btn btn-sm" type="button" disabled={busy !== null} onClick={() => void verify(d)}>
                  {busy === d.id ? "확인 중" : "연결 확인"}
                </button>
              )}
              <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} disabled={busy !== null} onClick={() => void remove(d)}>
                연결 해제
              </button>
            </div>
          </FormRow>
        ))}
        {list.domains.filter((d) => d.status === "PENDING_VERIFICATION").map((d) => (
          <FormRow key={`dns-${d.id}`} label="도메인 업체 설정값" help="반영까지 보통 10분 · 길면 하루 · 도메인을 산 업체의 DNS 설정에 넣어 주십시오">
            <table className="tbl" data-testid="dns-table">
              <thead>
                <tr>
                  <th scope="col">종류</th>
                  <th scope="col">이름(호스트)</th>
                  <th scope="col">값</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {[d.dns.connect, d.dns.verify].map((rec) => (
                  <tr key={rec.type}>
                    <td>{rec.type}</td>
                    <td className="col-text">{rec.name}</td>
                    <td className="col-text">{rec.value}</td>
                    <td>
                      <button className="btn btn-sm btn-out" type="button" onClick={() => void copy(rec.value)}>
                        복사
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </FormRow>
        ))}
        <FormRow label="안내">
          <span className="help">실제 도메인 연결(주소 연결 · 보안 인증서)은 준비 중입니다. 지금은 주소 등록과 소유 확인까지만 할 수 있습니다.</span>
        </FormRow>
      </FormSection>
    </div>
  );
}
