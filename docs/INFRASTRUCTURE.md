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
→ /home/ubuntu/LifeLeft/static-releases/<SHA>
→ 운영 URL 확정 후 기존 Nginx 443
```

기존 WeddingPick 런타임 및 경로 변경 금지.

LifeLeft 정적 파일 전용 디렉터리:

```text
/home/ubuntu/LifeLeft/
```

WeddingPick 정본 경로:

```text
/home/ubuntu/WeddingPick/
```

두 경로 혼용 금지.

운영 URL 또는 도메인 확정 전 Nginx route 변경 금지.

## Staging

수동 workflow:

```text
.github/workflows/stage-kakao-static.yml
```

수행 범위:

- GitHub-hosted runner 빌드
- Typecheck
- Static Export
- artifact 생성
- 기존 self-hosted runner 전달
- immutable candidate 저장
- `latest-candidate` 갱신

미수행:

- Nginx 설정 변경
- Nginx reload
- 443 route 변경
- DNS 변경
- public cutover

## 배포 안전 규칙

- main CI 성공 후 staging
- 빌드 결과 immutable release 보관
- 공개 전환 시 current 또는 release marker 방식 사용
- 이전 release 최소 1개 보존
- public smoke 성공 후 release 확정
- 실패 시 직전 설정 rollback
- Nginx 443 유지
- 8443 신규 도입 금지
- Render 관련 workflow 생성 금지
- WeddingPick 디렉터리 접근 금지
- staging script의 Nginx 명령 사용 금지

## 기존 runner

기존 label:

- `self-hosted`
- `Linux`
- `X64`
- `weddingpick-kakao`

LifeLeft 저장소에서 해당 runner scope가 허용되는지 실제 staging 실행 전 확인 필요.

## 공개 URL 결정

미확정:

- 전용 도메인
- 별도 host
- 기존 443 subpath

subpath 선택 시 Next.js `basePath`와 정적 asset 경로를 함께 변경해야 한다.

따라서 주소 확정 전 임의 `/lifeleft` 배포 금지.

## 현재 단계

- 코드/정적 export 완료
- CI 완료
- Kakao VM staging script 완료
- 수동 staging workflow 완료
- production route 미확정
- public cutover 미실행

상세: `docs/DEPLOYMENT.md`
