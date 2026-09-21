# LifeLeft KakaoCloud 배포 준비

> 기준일: 2026-09-21
> 상태: staging 준비 / 공개 전환 미실행

## 목적

기존 KakaoCloud VM과 기존 GitHub Actions 운영 방식을 재사용한다.

신규 대상:

- VM 없음
- DB 없음
- API 없음
- 컨테이너 없음
- Render 없음

## 정적 후보 경로

```text
/home/ubuntu/LifeLeft/
└ static-releases/
  ├ <commit-sha>/
  └ latest-candidate
```

WeddingPick 경로와 완전 분리:

```text
/home/ubuntu/WeddingPick/
/home/ubuntu/LifeLeft/
```

LifeLeft staging에서 금지:

- `/home/ubuntu/WeddingPick` 변경
- `/var/www/weddingpick` 변경
- `/etc/nginx` 변경
- Nginx reload
- 443 route 변경
- API health 의존
- DB 의존

## GitHub Actions

수동 workflow:

`.github/workflows/stage-kakao-static.yml`

구조:

```text
workflow_dispatch
→ GitHub-hosted build
→ Typecheck
→ Static Export
→ artifact
→ 기존 self-hosted runner
→ /home/ubuntu/LifeLeft/static-releases/<SHA>
```

공개 전환은 포함하지 않는다.

## runner 전제

기존 runner label:

```text
self-hosted
Linux
X64
weddingpick-kakao
```

LifeLeft 저장소에서 해당 runner 사용 권한이 허용되어 있어야 staging job 실행 가능.

권한 미확인 상태에서 자동 workflow 실행 금지.

## 공개 주소 결정 필요

현재 미확정:

- 전용 도메인
- 기존 443의 별도 host
- 기존 443의 subpath

### 전용 host 방식

Next.js basePath 변경 불필요.

### subpath 방식

예: `/lifeleft/`

필수:

- Next.js `basePath`
- asset path 검증
- Nginx location
- 공유 URL
- canonical
- sitemap

따라서 공개 경로 확정 전 임의 subpath 배포 금지.

## 공개 전환 조건

1. main CI 성공
2. staging workflow 성공
3. 후보 SHA 확인
4. 운영 URL 확정
5. Nginx 변경안 별도 검토
6. `nginx -t`
7. 공개 smoke
8. 실패 시 직전 설정 복구

## 현재 완료 범위

- 정적 export
- immutable staging script
- 수동 staging workflow
- 기존 VM 분리 경로
- Nginx 무변경 보장

## 현재 미실행

- self-hosted runner staging 실행
- Nginx route
- public URL
- DNS
- public smoke
