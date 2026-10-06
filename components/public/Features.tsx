import Link from "next/link";
import { PublicFrame } from "./PublicFrame";

// PF-002 기능 안내(디자인 PF-002). 화면 문구는 시안 그대로 해요체.
const SECTIONS: { title: string; lead: string; points: string[] }[] = [
  {
    title: "파트너스별 쇼핑몰",
    lead: "내 로고와 대표 색상으로 꾸민 모바일 쇼핑몰이에요. 기본 주소를 바로 받고, 내 도메인도 연결할 수 있어요.",
    points: ["상품 등록 · 사진 · 옵션 · 재고 일괄 수정", "주문 목록 · 상세 · 취소 · 환불 처리", "회원 목록과 등급 · 구매자 문의 답변"],
  },
  {
    title: "주문대기",
    lead: "주문대기는 결제가 끝난 주문이 방송 순서대로 모이는 목록이에요. 방송 중 들어온 주문이 순서대로 줄을 서요. 큰 버튼 하나로 개봉 시작 · 완료 · 취소를 처리하고, 타이머와 HIT 등록도 같은 화면에서 해요.",
    points: ["한 손 조작 · 단축키", "오픈 타이머 · 연장", "HIT 카드 등록 → 방송 화면 연출"],
  },
  {
    title: "OBS 방송 화면",
    lead: "세로 9:16과 가로 16:9, 기본 템플릿 3종. 브라우저 소스에 넣으면 크기 조정 없이 맞아요. 유튜브 채팅이 가리는 영역을 피해 위쪽에만 패널을 둬요.",
    points: ["현재 주문 카드 · 불꽃 발광 · 흐르는 닉네임", "명예의 전당 · 1위 금색 고정 · 세로 티커", "주문대기 · 공지 배너 · 주소와 시계"],
  },
  {
    title: "적립금 · 회원 등급",
    lead: "등급 이름과 개수, 적립률을 파트너스가 정해요. 적립금을 주고 거둔 기록이 모두 남아요. 실제 지급은 파트너스가 켜야 시작돼요(켜기 전에 한 번 더 물어봐요).",
    points: ["카드 · 무통장 적립률 구분", "회원별 잔액 · 소멸 예정", "실제 지급은 꺼진 채 시작 · 켤 때 한 번 더 확인"],
  },
  {
    title: "구매자 알림 · 도우미",
    lead: "주문 접수 · 개봉 완료 · 배송 · 답변을 알림톡으로 알려요. 안 되면 문자로 보내요. 파트너스가 막히면 도우미가 사용법을 답하고, 못 답하면 운영팀에 이어 드려요.",
    points: ["채널과 문구를 파트너스가 정함", "도우미는 답만 해요 · 실행하지 않아요"],
  },
];

export function Features() {
  return (
    <PublicFrame active="/features">
      <section className="pf-sec">
        <h1 className="t-d2">기능 안내</h1>
        <p className="t-b1 c-neu">쇼핑몰 · 방송 주문대기 · 방송 화면 · 적립금 · 알림 · 도우미. 한 계정, 한 요금제.</p>
        <div className="pf-feat-list">
          {SECTIONS.map((s) => (
            <article className="card pf-feat" key={s.title}>
              <h2 className="t-t3">{s.title}</h2>
              <p className="t-b2 c-neu">{s.lead}</p>
              <ul>
                {s.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
      <section className="pf-sec pf-alt pf-end">
        <h2 className="t-t1">오늘 쇼핑몰을 열고, 다음 방송부터 줄을 세워요</h2>
        <p className="t-b1 c-neu">자동 점검을 통과하면 바로 승인돼요.</p>
        <div className="pf-cta">
          <Link className="btn" href="/seller/signup">
            파트너스 가입 신청
          </Link>
          <Link className="btn btn-out" href="/pricing">
            요금 보기
          </Link>
        </div>
      </section>
    </PublicFrame>
  );
}
