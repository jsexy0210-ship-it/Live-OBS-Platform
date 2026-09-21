# LifeLeft 인프라 기준

> 기준일: 2026-09-21

## 원칙

**신규 인프라 없음**

재사용 대상:

- 기존 GitHub 저장소 체계
- 기존 GitHub Actions
- 기존 self-hosted runner 운영 방식
- 기존 KakaoCloud VM
- 기존 Nginx
- 기존 HTTPS 443

미사용:

- Render
- 신규 VM
- 신규 PostgreSQL
- 신규 Redis
- 신규 API 서버
- 별도 컨테이너 런타임

## 배포 형태

```text
GitHub
→ CI
→ Next.js Static Export
→ 기존 KakaoCloud VM
→ 별도 정적 디렉터리
→ 기존 Nginx 443
```

기존 WeddingPick 런타임 및 경로 변경 금지.

LifeLeft 정적 파일 전용 디렉터리 분리.

운영 URL 또는 도메인 확정 전 Nginx route 변경 금지.

## 배포 안전 규칙

- main CI 성공 후 배포
- 빌드 결과 immutable release 보관
- current symlink 전환 방식 권장
- 이전 release 최소 1개 보존
- public smoke 성공 후 release 확정
- 실패 시 symlink rollback
- Nginx 443 유지
- 8443 신규 도입 금지
- Render 관련 workflow 생성 금지

## 현재 단계

- 코드/정적 export 준비
- CI 준비
- production route 미확정
- production 배포 미실행
