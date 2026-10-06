main의 CI가 성공해도 obs-web-test 배포는 수동 실행을 기다리고 있습니다. 이제 main push의 CI 성공을 받아 현재 main과 일치하는 SHA만 self-hosted obs-kakao runner에서 배포합니다. 수동 재배포도 같은 CI/SHA 검증을 통과해야 합니다.

배포 후와 매주 월요일 03:00 KST에 디스크 정리를 실행합니다. 자동 DB 백업 최신 3개, 최근 성공 SHA 3개와 롤백 SHA의 이미지, 컨테이너 참조 이미지를 보존합니다. 수동 백업, DB volume, .env, runner 파일은 삭제하지 않습니다. dangling 이미지와 build cache 정리는 Docker daemon 전체 범위라는 제한을 문서에 명시했습니다.

검증: 정리 fixture 17/17, gate/SHA 재검증 모의 API 사례 15/15, CI workflow 허용 범위 검사, shell 블록 11개 및 정리 script 문법 검사, diff check 통과. 열린 PR 24개와 변경 경로를 대조했고 #572와의 합성 merge-tree는 충돌 없이 외부 쇼핑몰 환경 반영 단계를 보존했습니다.

실제 self-hosted runner 배포, VM 복구, 서버상의 Environment 보호 설정 및 원격 CI는 아직 검증하지 않았습니다. 자동 재시도나 자동 롤백은 추가하지 않습니다.
