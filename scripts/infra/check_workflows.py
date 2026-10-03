"""기존 배포 전면 금지를 테스트 환경 한 곳의 명시적 허용 정책으로 바꾼다."""
from pathlib import Path
import re
import sys
import yaml

GUARD = "github.repository == 'jsexy0210-ship-it/Live-OBS-Platform' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.confirm_target == 'obs-web-test'"
ALLOWED = 'deploy-obs-test.yml'


def require(value, message):
    if not value:
        raise ValueError(message)


def validate(name, workflow):
    require(isinstance(workflow, dict), '워크플로 매핑 필요')
    jobs = workflow.get('jobs', {})
    require(isinstance(jobs, dict), 'jobs 매핑 필요')
    for key, job in jobs.items():
        runner = job.get('runs-on')
        if name == ALLOWED and key == 'deploy':
            require(runner == ['self-hosted', 'Linux', 'X64', 'obs-kakao', 'obs-test'], '전용 runner 레이블 필요')
        else:
            require(runner in ('ubuntu-latest', 'ubuntu-24.04'), '다른 작업은 GitHub 호스팅 runner만 허용')
    require('pull_request_target' not in workflow.get('on', {}), 'pull_request_target 실행 금지')
    if name != ALLOWED:
        return
    require(set(workflow.get('on', {})) == {'workflow_dispatch'}, '배포는 수동 실행만 허용')
    require(workflow.get('permissions') == {'contents': 'read', 'actions': 'read'}, '최소 읽기 권한 필요')
    require(workflow.get('concurrency') == {'group': 'obs-test-deploy', 'cancel-in-progress': 'false'}, '배포 중단·중복 실행 방지 필요')
    require(set(jobs) == {'authorize', 'build', 'deploy', 'verify'}, '허용된 배포 단계만 사용')
    for key, job in jobs.items():
        require(job.get('if', '').strip() == GUARD, '저장소·main·수동 실행·대상 확인 가드 필요')
        require('permissions' not in job, '작업별 권한 확장 금지')
        for step in job.get('steps', []):
            if 'uses' in step:
                require(re.fullmatch(r'actions/[a-z-]+@[0-9a-f]{40}', step['uses']), 'Action 커밋 SHA 고정 필요')
        if key != 'deploy':
            require('environment' not in job, '테스트 비밀정보는 배포 단계만 접근')
    require('successful main CI' in str(jobs['authorize']) and 'head_sha=' in str(jobs['authorize']), '정확한 main SHA CI 성공 확인 필요')
    require(jobs['build'].get('needs') == 'authorize', '공개 여부 확인 후 빌드')
    require(jobs['deploy'].get('needs') == 'build', '검증된 아티팩트만 배포')
    require(jobs['verify'].get('needs') == 'deploy', '서버 배포 후 외부 검증')
    require(jobs['deploy'].get('environment') == 'obs-test', 'obs-test Environment 필요')
    require("event['repository']['private'] is not True" in str(jobs['authorize']), 'Public 저장소 상주 runner 차단 필요')
    require('secrets.' not in str(workflow), '비밀정보를 전달하는 배포 파이프라인 금지; VM의 제한된 설정 사용')


def main():
    directory = Path(__file__).resolve().parents[2] / '.github/workflows'
    for path in sorted([*directory.glob('*.yml'), *directory.glob('*.yaml')]):
        validate(path.name, yaml.load(path.read_text(), Loader=yaml.BaseLoader))
    print('Workflow deployment policy passed.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, yaml.YAMLError) as error:
        print(f'Workflow policy failed: {error}', file=sys.stderr)
        sys.exit(1)
