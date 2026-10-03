import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/infra'))
import check_workflows as policy
import deploy_obs_test as deployment
import dns_preflight as dns


class WorkflowPolicy(unittest.TestCase):
    def setUp(self):
        self.w = yaml.load((ROOT / '.github/workflows/deploy-obs-test.yml').read_text(), Loader=yaml.BaseLoader)

    def test_valid(self):
        policy.validate(policy.ALLOWED, self.w)

    def test_unsafe_mutations(self):
        mutations = [
            lambda w: w['on'].update(pull_request=''),
            lambda w: w['jobs']['deploy'].update(environment='production'),
            lambda w: w['jobs']['deploy'].update({'if': 'always()'}),
            lambda w: w['jobs']['deploy'].update({'runs-on': ['self-hosted']}),
            lambda w: w['permissions'].update(contents='write'),
            lambda w: w['jobs']['deploy'].update(needs='authorize'),
            lambda w: w['concurrency'].update({'cancel-in-progress': 'true'}),
            lambda w: w['jobs']['authorize'].update(steps=[]),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                bad = copy.deepcopy(self.w); mutation(bad)
                with self.assertRaises(ValueError): policy.validate(policy.ALLOWED, bad)

    def test_other_workflow_cannot_use_runner(self):
        with self.assertRaises(ValueError):
            policy.validate('other.yml', {'jobs': {'unsafe': {'runs-on': ['self-hosted']}}})

    def test_unpinned_action(self):
        self.w['jobs']['deploy']['steps'][0]['uses'] = 'actions/download-artifact@v4'
        with self.assertRaises(ValueError): policy.validate(policy.ALLOWED, self.w)


class DNS(unittest.TestCase):
    def test_match(self):
        dns.validate_records({'210.109.15.68'}, set())

    def test_wrong_ip(self):
        with self.assertRaises(RuntimeError): dns.validate_records({'192.0.2.1'}, set())

    def test_stale_aaaa(self):
        with self.assertRaises(RuntimeError): dns.validate_records({'210.109.15.68'}, {'2001:db8::1'})

    def test_extra_ip(self):
        with self.assertRaises(RuntimeError): dns.validate_records({'210.109.15.68', '192.0.2.1'}, set())


class Bundle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        (self.root / 'src').mkdir()
        (self.root / 'src/release.sha').write_text('a'*40)
        (self.root / 'src/migrations.sha').write_text('b'*64)
        (self.root / 'images.tar').write_bytes(b'test-only-not-a-real-image')
        self.manifest = {str(p.relative_to(self.root)): deployment.digest(p)
                         for p in self.root.rglob('*') if p.is_file()}
        (self.root / 'manifest.json').write_text(json.dumps(self.manifest))

    def tearDown(self): self.tmp.cleanup()

    def test_valid(self): self.assertEqual(deployment.verify_bundle(self.root, 'a'*40), 'b'*64)

    def test_wrong_sha(self):
        with self.assertRaises(RuntimeError): deployment.verify_bundle(self.root, 'b'*40)

    def test_tamper(self):
        (self.root/'images.tar').write_bytes(b'changed')
        with self.assertRaises(RuntimeError): deployment.verify_bundle(self.root, 'a'*40)

    def test_extra_file(self):
        (self.root/'extra.env').write_text('not-a-secret')
        with self.assertRaises(RuntimeError): deployment.verify_bundle(self.root, 'a'*40)

    def test_link(self):
        (self.root/'link').symlink_to(self.root/'images.tar')
        with self.assertRaises(RuntimeError): deployment.verify_bundle(self.root, 'a'*40)


class RuntimeSecrets(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
        self.env=self.root/'.env'
        self.env.write_text('POSTGRES_USER=obs\nPOSTGRES_DB=obs\nOBS_ALLOW_LOCAL_DB=1\n'+
            ''.join(k+'='+'a'*32+'\n' for k in ('POSTGRES_PASSWORD','IDENTITY_HASH_KEY','BILLING_KEY_SECRET'))+
            'RESEND_API_KEY=not-a-real-key\nDOCKER_HOST=tcp_remote_should_not_be_used\n')
        self.env.chmod(0o600)

    def tearDown(self): self.tmp.cleanup()

    def test_only_allowlisted_configuration(self):
        config=deployment.read_config(self.root)
        self.assertNotIn('RESEND_API_KEY',config); self.assertNotIn('DOCKER_HOST',config)

    def test_insecure_file_rejected(self):
        self.env.chmod(0o644)
        with self.assertRaises(RuntimeError): deployment.read_config(self.root)

    def test_requires_explicit_local_database_ack(self):
        self.env.write_text(self.env.read_text().replace('OBS_ALLOW_LOCAL_DB=1','OBS_ALLOW_LOCAL_DB=0'))
        with self.assertRaises(RuntimeError): deployment.read_config(self.root)

    def test_command_failure_does_not_expose_stderr(self):
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([],1,b'',b'password=DO_NOT_LOG')):
            with self.assertRaises(RuntimeError) as result: deployment.run(['test'], '안전한 단계')
        self.assertNotIn('DO_NOT_LOG',str(result.exception))


class ComposeIsolation(unittest.TestCase):
    def test_ports_environment_and_volumes(self):
        c=yaml.safe_load((ROOT/'deploy/docker-compose.yml').read_text()); s=c['services']
        self.assertNotIn('ports',s['obs-web-db']); self.assertNotIn('ports',s['obs-web-app'])
        self.assertNotIn('env_file',s['obs-web-app'])
        self.assertEqual(s['obs-web-app']['environment']['BILLING_PROVIDER'],'')
        self.assertIn('443:443',s['obs-web-proxy']['ports'])
        self.assertIn('obs-web-pgdata',c['volumes']); self.assertIn('obs-web-caddy-data',c['volumes'])


class DomainPolicy(unittest.TestCase):
    def test_domain_and_allowlist_are_exact_root(self):
        c=yaml.safe_load((ROOT/'deploy/docker-compose.yml').read_text())
        self.assertEqual(dns.DOMAIN, 'on-aircue.com')
        self.assertEqual(c['services']['obs-web-app']['environment']['OBS_ALLOWED_HOSTS'], dns.DOMAIN)
        self.assertEqual(c['services']['obs-web-app']['environment']['OBS_ENFORCE_HOST_POLICY'], '1')

    def test_caddy_and_workflow_have_no_old_certificate_target(self):
        c=(ROOT/'deploy/Caddyfile.https').read_text()
        w=(ROOT/'.github/workflows/deploy-obs-test.yml').read_text()
        self.assertIn('on-aircue.com {', c)
        self.assertIn('https://on-aircue.com{uri}', c)
        for bad in ('live-obs-test.duckdns.org', 'www.on-aircue.com {', '*.on-aircue.com'):
            self.assertNotIn(bad, c)
            self.assertNotIn(bad, w)
        self.assertIn('header_up Host on-aircue.com', c)
        self.assertIn('respond "Misdirected request" 421', c)

    def test_compose_does_not_load_raw_environment_file(self):
        cmd, env=deployment.compose(Path('/opt/obs/releases/'+'a'*40), 'a'*40,
                                    {'POSTGRES_USER': 'obs'}, True)
        self.assertEqual(cmd[cmd.index('--env-file')+1], '/dev/null')
        self.assertEqual(env['OBS_CADDY_FILE'], './Caddyfile.https')
        self.assertNotIn('RESEND_API_KEY', env)

    def test_missing_ci_approval_check_is_rejected(self):
        w=yaml.load((ROOT/'.github/workflows/deploy-obs-test.yml').read_text(), Loader=yaml.BaseLoader)
        w['jobs']['authorize']['steps']=w['jobs']['authorize']['steps'][:1]
        with self.assertRaises(ValueError): policy.validate(policy.ALLOWED,w)


if __name__ == '__main__': unittest.main()
