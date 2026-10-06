import { formatDate } from "../../../../lib/client/format";

// 사업자등록증 행의 값(MA-013 검토 패널 · MA-014 상세 공용). 신청 응답의 license(파일 정보 + viewUrl)를 그대로 쓴다.
// viewUrl은 최고관리자·운영에게만 오고(그 밖의 역할은 null), 열 때마다 로그 추적에 남는다. 파일이 없으면 올리지 않은 것으로 안내한다.
export type License = { fileName: string; mimeType: string; byteSize: number; uploadedAt: string; viewUrl: string | null };
const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);

export function LicenseValue({ license }: { license: License | null | undefined }) {
  if (!license) return <span className="c-alt">올린 파일이 없습니다</span>;
  return (
    <span className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }} data-testid="license-value">
      <span>
        {license.fileName} · {size(license.byteSize)} · {formatDate(license.uploadedAt)}
      </span>
      {license.viewUrl && (
        <>
          <a className="btn btn-sm btn-out" href={license.viewUrl} target="_blank" rel="noopener noreferrer">
            보기
          </a>
          <a className="btn btn-sm btn-out" href={`${license.viewUrl}?download=1`}>
            내려받기
          </a>
        </>
      )}
    </span>
  );
}
