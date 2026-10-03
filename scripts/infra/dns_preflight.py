"""테스트 도메인의 A/AAAA 확인. Cloudflare API 토큰이나 자격정보를 사용하지 않는다."""
import json
import socket
import urllib.parse
import urllib.request

DOMAIN = "on-aircue.com"
EXPECTED_IP = "210.109.15.68"


def records(resolver, kind):
    query = urllib.parse.urlencode({"name": DOMAIN, "type": kind})
    request = urllib.request.Request(
        f"{resolver}?{query}", headers={"Accept": "application/dns-json"}
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.load(response)
    if result.get("Status") != 0:
        raise RuntimeError("DNS 응답 오류. 현재 앱/프록시는 변경하지 않습니다.")
    code = 1 if kind == "A" else 28
    return {r["data"] for r in result.get("Answer", []) if r.get("type") == code}


def validate_records(a, aaaa):
    if a != {EXPECTED_IP}:
        raise RuntimeError("A 레코드가 테스트 VM IP와 일치하지 않습니다.")
    if aaaa:
        raise RuntimeError("이 IPv4 전용 구성에서는 AAAA 레코드를 먼저 확인·제거해야 합니다.")


def check():
    for resolver in ("https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"):
        validate_records(records(resolver, "A"), records(resolver, "AAAA"))
    local = {r[4][0] for r in socket.getaddrinfo(DOMAIN, 443, socket.AF_INET)}
    validate_records(local, set())
    print("DNS preflight passed: A matches obs-web-test; no public AAAA")


if __name__ == "__main__":
    try:
        check()
    except Exception:
        raise SystemExit("DNS preflight failed. Cloudflare DNS-only A/AAAA와 DNS 전파를 확인하세요.") from None
