import { formatDate, formatDateTime } from "../../../lib/client/format";
import { won } from "../format";

// SA-090 청구 내역(최근 24건, 서버가 최신 순으로 준다). 영수증 주소는 http(s)일 때만 링크로 연다.
export type Payment = {
  id: string;
  amount: number;
  status: "PENDING" | "PAID" | "FAILED";
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  receiptUrl: string | null;
  createdAt: string;
};

const STATUS: Record<Payment["status"], { label: string; cls: string }> = {
  PAID: { label: "결제 완료", cls: "b-done" },
  PENDING: { label: "결제 확인 중", cls: "b-wait" },
  FAILED: { label: "결제 실패", cls: "b-fail" },
};

const DAY = (iso: string | null) => (iso ? formatDate(iso, "-") : "-");

const safeUrl = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

export function PaymentHistory({ payments }: { payments: Payment[] }) {
  return (
    <section className="card col" aria-labelledby="sub-history">
      <h2 className="t-hl1 pad-l" id="sub-history" style={{ paddingBottom: 12 }}>
        청구 내역
      </h2>
      {payments.length === 0 ? (
        <div className="st">
          <span className="t">청구 내역이 없습니다</span>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl sub-tbl">
            <thead>
              <tr>
                <th>결제일</th>
                <th>이용한 기간</th>
                <th>금액</th>
                <th>상태</th>
                <th>영수증</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => {
                const url = safeUrl(p.receiptUrl);
                return (
                  <tr key={p.id} data-testid="sub-payment">
                    <td className="num">{formatDateTime(p.paidAt ?? p.createdAt, "-")}</td>
                    <td className="num">{p.periodStart ? `${DAY(p.periodStart)} ~ ${DAY(p.periodEnd)}` : "-"}</td>
                    <td className="num">{won(p.amount)}</td>
                    <td>
                      <span className={`bdg ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
                    </td>
                    <td>
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          영수증 보기
                        </a>
                      ) : (
                        <span className="c-alt">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
