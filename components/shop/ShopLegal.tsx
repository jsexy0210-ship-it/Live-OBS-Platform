import ShopState from "./ShopState";
import "./ShopLegal.css";

// 쇼핑몰 이용약관·개인정보처리방침 구매자 화면. 파트너스가 입력한 본문만 글자 그대로(텍스트로만, HTML 해석 없음) 보여 주고,
// 게시 전에는 「준비 중」 안내만 둔다(법률 문구를 앱이 대신 쓰지 않음). doc이 null이면 운영 중이 아닌 쇼핑몰.
type Doc = { published: false } | { published: true; body: string; effectiveOn: string | null };
const TITLE = { terms: "이용약관", privacy: "개인정보처리방침" } as const;

export default function ShopLegal({ kind, doc }: { kind: keyof typeof TITLE; doc: Doc | null }) {
  const title = TITLE[kind];
  if (!doc) return <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />;
  if (!doc.published) return <ShopState title={`${title}을 준비하고 있어요`} body="정해지는 대로 이 페이지에서 알려 드려요. 궁금한 점은 판매자에게 문의해 주세요." />;
  return (
    <section className="card shop-card" data-testid="shop-legal">
      <header className="shop-legal-head">
        <h1 className="t-h1">{title}</h1>
        {doc.effectiveOn && <p className="t-c1 c-alt">시행일 {doc.effectiveOn.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_m, y, mo, d) => `${y}년 ${+mo}월 ${+d}일`)}</p>}
      </header>
      <p className="t-b1 shop-legal-body" data-testid="shop-legal-body">
        {doc.body}
      </p>
    </section>
  );
}
