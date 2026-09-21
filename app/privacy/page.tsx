import type { Metadata } from "next";
import { BUSINESS, CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "개인정보처리방침",
  description: "인생잔량 개인정보 처리 및 광고 쿠키 안내",
  alternates: { canonical: "/privacy/" },
  openGraph: { url: "/privacy/", title: "개인정보처리방침", description: "인생잔량 개인정보 처리 및 광고 쿠키 안내" }
};

export default function PrivacyPage() {
  return (
    <main className="pageShell docPage">
      <p className="eyebrow">PRIVACY</p>
      <h1>개인정보처리방침</h1>
      <p className="docMeta">시행일 2026.09.21</p>

      <section>
        <h2>1. 수집 항목</h2>
        <p>인생잔량은 회원가입·로그인 기능이 없으며 이름, 이메일, 연락처 등 개인을 식별하는 정보를 수집하지 않습니다.</p>
      </section>

      <section>
        <h2>2. 입력값 저장</h2>
        <p>나이, 급여, 지출, 구독료 등 계산기 입력값은 이용자 브라우저의 localStorage에만 저장되며 서버로 전송·저장되지 않습니다.</p>
        <p>브라우저의 사이트 데이터 삭제로 언제든지 제거할 수 있습니다.</p>
      </section>

      <section>
        <h2>3. 광고 및 쿠키</h2>
        <p>본 사이트는 Google AdSense를 통해 광고를 게재합니다.</p>
        <ul>
          <li>Google을 포함한 제3자 공급업체는 쿠키를 사용하여 이용자의 본 사이트 또는 다른 웹사이트 방문 기록을 기반으로 광고를 게재합니다.</li>
          <li>Google은 광고 쿠키를 사용하여 이용자의 본 사이트 및 인터넷상의 다른 사이트 방문 기록을 바탕으로 Google 및 파트너가 광고를 게재할 수 있도록 합니다.</li>
          <li>
            이용자는{" "}
            <a href="https://adssettings.google.com" target="_blank" rel="noopener noreferrer">Google 광고 설정</a>
            에서 맞춤 광고를 사용 중지할 수 있으며,{" "}
            <a href="https://www.aboutads.info" target="_blank" rel="noopener noreferrer">www.aboutads.info</a>
            에서 제3자 공급업체의 맞춤 광고 쿠키 사용을 거부할 수 있습니다.
          </li>
          <li>
            자세한 내용 ·{" "}
            <a href="https://policies.google.com/technologies/ads?hl=ko" target="_blank" rel="noopener noreferrer">Google 광고 정책</a>
          </li>
        </ul>
      </section>

      <section>
        <h2>4. 서버 로그</h2>
        <p>웹 서버는 서비스 운영과 보안을 위해 접속 IP, 요청 경로, 브라우저 정보 등 표준 접속 로그를 일시적으로 기록할 수 있습니다.</p>
      </section>

      <section>
        <h2>5. 운영자 및 문의</h2>
        <p>{BUSINESS.name} · 대표 {BUSINESS.representative} · 사업자등록번호 {BUSINESS.registrationNumber}</p>
        <p>
          개인정보 보호책임자 · {BUSINESS.representative} ·{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </section>

      <section>
        <h2>6. 변경</h2>
        <p>본 방침이 변경되는 경우 이 페이지에 게시합니다.</p>
      </section>
    </main>
  );
}
