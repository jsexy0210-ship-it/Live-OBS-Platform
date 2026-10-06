import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import type { LandingPlan } from "./Landing";
import { LandingSample } from "./LandingSample";
import "../../styles/pf-sample.css";

// PF-002 기능 안내(정본 PF-002 보드): 기능별 좌우 교대 섹션(글 + 견본). 문구는 해요체.
// 견본 줄: [이름, 오른쪽 값, 배지 종류(없으면 글자)]
type Row = [string, string, string?];
const SECTIONS: { title: string; lead: string; points: string[]; mock: Row[] | "overlay" }[] = [
  {
    title: "파트너스별 쇼핑몰",
    lead: "내 로고와 대표 색상으로 꾸민 모바일 쇼핑몰이에요. 기본 주소를 바로 받고, 내 도메인도 연결할 수 있어요.",
    points: ["상품 등록 · 사진 · 옵션 · 재고 일괄 수정", "주문 목록 · 상세 · 취소 · 환불 처리", "회원 목록과 등급 · 구매자 문의 답변"],
    mock: [["스타라이트 부스터 박스", "89,100원"], ["문라이트 컬렉션 박스", "132,000원"], ["주문 24건 · 오늘", "답변 대기 5", "b-warn"]],
  },
  {
    title: "주문대기",
    lead: "주문대기는 결제가 끝난 주문이 방송 순서대로 모이는 목록이에요. 방송 중 들어온 주문이 순서대로 줄을 서요. 큰 버튼 하나로 개봉 시작 · 완료 · 취소를 처리하고, 타이머와 HIT 등록도 같은 화면에서 해요.",
    points: ["한 손 조작 · 단축키", "오픈 타이머 · 연장", "HIT 카드 등록 → 방송 화면 연출"],
    mock: [["14:02 별빛사냥꾼", "지금 개봉 중", "b-open"], ["14:03 카드왕", "다음", "b-wait"], ["14:04 민트컨디션", "대기", "b-wait"]],
  },
  {
    title: "OBS 방송 화면",
    lead: "세로 9:16과 가로 16:9, 기본 템플릿 3종. 브라우저 소스에 넣으면 크기 조정 없이 맞아요. 유튜브 채팅이 가리는 영역을 피해 위쪽에만 패널을 둬요.",
    points: ["현재 주문 카드 · 불꽃 발광 · 흐르는 닉네임", "인기 카드 · 1위 금색 고정 · 세로 티커", "주문대기 · 공지 배너 · 주소와 시계"],
    mock: "overlay",
  },
  {
    title: "적립금 · 회원 등급",
    lead: "등급 이름과 개수, 적립률을 파트너스가 정해요. 지급 · 회수 · 실패가 모두 원장에 남고, 실제 지급은 스위치를 켤 때만 나가요.",
    points: ["카드 · 무통장 적립률 구분", "회원별 잔액 · 소멸 예정", "실제 지급 스위치 · 기본 꺼짐 · 켤 때 두 번 확인"],
    mock: [["VIP 적립률", "3%"], ["지급 대기", "12건", "b-wait"], ["실제 지급", "꺼짐", "b-gray nodot"]],
  },
  {
    title: "구매자 알림 · 도우미",
    lead: "주문 접수 · 개봉 완료 · 배송 · 답변을 알림톡으로 알려요. 안 되면 문자로 보내요. 파트너스가 막히면 도우미가 사용법을 답하고, 못 답하면 운영팀에 이어 드려요.",
    points: ["채널과 문구를 파트너스가 정함", "도우미는 답만 해요 · 실행하지 않아요"],
    mock: [["개봉 완료", "알림톡", "c-alt"], ["도우미", "오늘 13번 남음", "c-alt"]],
  },
];

function Mock({ mock }: { mock: Row[] | "overlay" }) {
  return (
    <div className="card pf-mock">
      {mock === "overlay" ? (
        <LandingSample small />
      ) : (
        <div className="card col pf-mock-in">
          {mock.map(([l, v, k]) => (
            <div className="row between pf-mock-row" key={l}>
              <span className="t-l2 fw6">{l}</span>
              {k?.startsWith("b-") ? <span className={`bdg ${k}`}>{v}</span> : k === "c-alt" ? <span className="t-c1 c-alt">{v}</span> : <span className="t-l2 num">{v}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Check() {
  return (
    <span className="pf-chk">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12l5 5L20 7" />
      </svg>
    </span>
  );
}

export function Features({ plans = [] }: { plans?: LandingPlan[] }) {
  const trial = plans.find((p) => p.trialDays > 0);
  return (
    <PublicFrame active="/features">
      <section className="pf-sec pf-feat-page">
        <h1 className="t-d2">기능 안내</h1>
        <p className="t-b1 c-neu">쇼핑몰 · 방송 주문대기 · 방송 화면 · 적립금 · 알림 · 도우미. 한 계정, 한 요금제.</p>
        {SECTIONS.map((s, i) => (
          <div className={`pf-feat-row${i % 2 ? " rev" : ""}`} key={s.title}>
            <div className="col pf-feat-text">
              <h2 className="t-t2">{s.title}</h2>
              <p className="t-b1 c-neu">{s.lead}</p>
              <div className="col" style={{ gap: 8 }}>
                {s.points.map((p) => (
                  <span className="row t-l1" style={{ gap: 8 }} key={p}>
                    <Check />
                    <span className="c-neu">{p}</span>
                  </span>
                ))}
              </div>
            </div>
            <Mock mock={s.mock} />
          </div>
        ))}
      </section>
      <section className="pf-sec pf-end">
        <h2 className="t-t1">오늘 쇼핑몰을 열고, 다음 방송부터 줄을 세워요</h2>
        <p className="t-b1 c-neu">
          자동 점검을 통과하면 바로 승인돼요.
          {trial ? ` ${trial.name}은 승인되면 ${trial.trialDays}일 동안 체험할 수 있어요.` : ""}
        </p>
        <div className="pf-cta">
          <Link className="btn btn-lg" href="/seller/signup">
            파트너스 가입 신청
          </Link>
          <Link className="btn btn-lg btn-out" href="/pricing">
            요금 보기
          </Link>
        </div>
      </section>
    </PublicFrame>
  );
}
