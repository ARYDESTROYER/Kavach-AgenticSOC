"""Round 11 — enrichment-provider expansion (19 new providers), fully offline.

Covers every Round-11 provider (7 keyless + 12 key-gated) with the established
Wave-2 patterns: ``_patch_http`` mocks the ``http_json``/``http_json_soft`` symbols
AS IMPORTED INTO each provider module; DNS providers get their module-level blocking
helper monkeypatched; the autouse network guard blocks any real socket. The
non-negotiables under test:

  * #3 — CONTEXT providers (circl_hashlookup / dshield / onionoo / robtex / crt_sh /
    securitytrails / netlas) stay <= 40 with ``malicious=False`` in every branch so
    they can never alone cross the legacy ``max()`` >= 50 fusion cut; verdict feeds
    (Safe Browsing / MHR / Spamhaus / Hybrid Analysis) score 80-90.
  * fail-open — a missing key, a 404 / empty body, and a transport error all degrade
    (``ok=False`` with a recorded error, or a neutral clean miss) — never an
    exception, never a dropped alert.
  * #10 — a key embedded in a URL path (IPQualityScore) never reaches the recorded
    error.
  * the manifest carries the Round-11 ``setup_steps`` + ``example`` fields and the
    router serialises them.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.config import EnrichmentConfig, Secrets
from app.constants import IndicatorKind

# --------------------------------------------------------------------------- #
# helpers (copied from test_round3_wave2_enrichment.py — the established template)
# --------------------------------------------------------------------------- #


def _secrets(**overrides: Any) -> Secrets:
    return Secrets(_env_file=None, **overrides)  # type: ignore[call-arg]


def _patch_http(monkeypatch, payload, *, target_module: str) -> list[dict]:
    """Patch the HTTP helper imported into ``target_module`` to return ``payload``
    (or call it if it's a callable). Handles both the hard ``http_json`` symbol and
    the soft ``http_json_soft`` symbol. Returns a captured-calls list."""
    import importlib

    calls: list[dict] = []

    async def fake(url, **kwargs):  # noqa: ANN001
        calls.append({"url": url, **kwargs})
        return payload(url, **kwargs) if callable(payload) else payload

    mod = importlib.import_module(target_module)
    for attr in ("http_json", "http_json_soft"):
        if hasattr(mod, attr):
            monkeypatch.setattr(mod, attr, fake)
    return calls


def _patch_http_raises(monkeypatch, exc: Exception, *, target_module: str) -> None:
    """Patch the HTTP helper(s) in ``target_module`` to RAISE ``exc``."""
    import importlib

    async def fake(url, **kwargs):  # noqa: ANN001
        raise exc

    mod = importlib.import_module(target_module)
    for attr in ("http_json", "http_json_soft"):
        if hasattr(mod, attr):
            monkeypatch.setattr(mod, attr, fake)


# --------------------------------------------------------------------------- #
# CIRCL hashlookup — keyless known-GOOD context, default ON
# --------------------------------------------------------------------------- #
async def test_circl_hashlookup_hit_is_known_good_context(monkeypatch) -> None:
    from app.enrichment.providers import circl_hashlookup

    _patch_http(monkeypatch,
                {"SHA-256": "a" * 64, "FileName": "notepad.exe", "hashlookup:trust": 100},
                target_module="app.enrichment.providers.circl_hashlookup")
    prov = circl_hashlookup.CirclHashlookupProvider(EnrichmentConfig(), _secrets())
    r = await prov.lookup("a" * 64, IndicatorKind.FILE_HASH)
    # Known-good is CONTEXT: score stays 0, never malicious (#3).
    assert r.ok and r.score == 0 and r.malicious is False
    assert "known_good" in r.tags and r.raw["known"] is True


async def test_circl_hashlookup_miss_and_unsupported_are_neutral(monkeypatch) -> None:
    from app.enrichment.providers import circl_hashlookup

    _patch_http(monkeypatch, None, target_module="app.enrichment.providers.circl_hashlookup")
    prov = circl_hashlookup.CirclHashlookupProvider(EnrichmentConfig(), _secrets())
    r = await prov.lookup("b" * 64, IndicatorKind.FILE_HASH)
    assert r.ok and r.score == 0 and r.raw["known"] is False
    r2 = await prov.lookup("nothex", IndicatorKind.FILE_HASH)
    assert r2.ok and r2.score == 0 and r2.raw["supported"] is False


# --------------------------------------------------------------------------- #
# SANS ISC DShield — keyless sightings context, default ON, capped <= 40
# --------------------------------------------------------------------------- #
async def test_dshield_heavy_reporter_capped_at_40(monkeypatch) -> None:
    from app.enrichment.providers import dshield

    _patch_http(monkeypatch,
                {"ip": {"count": 50000, "attacks": 900,
                        "threatfeeds": {"blocklistde22": {}}, "asname": "EVIL-AS"}},
                target_module="app.enrichment.providers.dshield")
    prov = dshield.DShieldProvider(EnrichmentConfig(), _secrets())
    r = await prov.lookup("203.0.113.9", IndicatorKind.IP)
    # Sightings context: scaled but CAPPED at 40 and never malicious (#3).
    assert r.ok and r.score == 40 and r.malicious is False
    assert any(t.startswith("feed:") for t in r.tags)


async def test_dshield_unseen_and_unreachable_are_clean(monkeypatch) -> None:
    from app.enrichment.providers import dshield

    _patch_http(monkeypatch, {"ip": {"count": 0, "attacks": 0}},
                target_module="app.enrichment.providers.dshield")
    prov = dshield.DShieldProvider(EnrichmentConfig(), _secrets())
    r = await prov.lookup("198.51.100.1", IndicatorKind.IP)
    assert r.ok and r.score == 0 and r.malicious is False
    # Soft transport failure (payload None) → neutral no-data, ok=True, NO error.
    _patch_http(monkeypatch, None, target_module="app.enrichment.providers.dshield")
    r2 = await prov.lookup("198.51.100.1", IndicatorKind.IP)
    assert r2.ok and r2.score == 0 and not r2.error


# --------------------------------------------------------------------------- #
# Onionoo — keyless Tor context, default ON
# --------------------------------------------------------------------------- #
async def test_onionoo_exit_node_is_anonymity_context(monkeypatch) -> None:
    from app.enrichment.providers import onionoo

    _patch_http(monkeypatch,
                {"relays": [{"nickname": "fastexit1", "flags": ["Exit", "Running"],
                             "or_addresses": ["185.220.101.1:443"],
                             "exit_addresses": ["185.220.101.1"],
                             "running": True, "country": "de"}]},
                target_module="app.enrichment.providers.onionoo")
    prov = onionoo.OnionooProvider(EnrichmentConfig(), _secrets())
    r = await prov.lookup("185.220.101.1", IndicatorKind.IP)
    # Anonymity context: 40 for an exit, never malicious (#3).
    assert r.ok and r.score == 40 and r.malicious is False
    assert "tor_exit" in r.tags


async def test_onionoo_non_exit_relay_and_miss(monkeypatch) -> None:
    from app.enrichment.providers import onionoo

    _patch_http(monkeypatch,
                {"relays": [{"nickname": "mid", "flags": ["Fast"], "running": True,
                             "or_addresses": ["192.0.2.7:9001"]}]},
                target_module="app.enrichment.providers.onionoo")
    prov = onionoo.OnionooProvider(EnrichmentConfig(), _secrets())
    r = await prov.lookup("192.0.2.7", IndicatorKind.IP)
    assert r.ok and r.score == 20 and "tor_relay" in r.tags
    _patch_http(monkeypatch, {"relays": []}, target_module="app.enrichment.providers.onionoo")
    r2 = await prov.lookup("192.0.2.8", IndicatorKind.IP)
    assert r2.ok and r2.score == 0 and r2.raw["tor_relay"] is False


async def test_onionoo_prefix_match_is_not_a_tor_hit(monkeypatch) -> None:
    """Onionoo ``search`` is a PREFIX match — a relay at 185.220.101.10 must not
    tag the distinct IP 185.220.101.1 as Tor (false 'tor_exit' evidence)."""
    from app.enrichment.providers import onionoo

    _patch_http(monkeypatch,
                {"relays": [{"nickname": "otherexit", "flags": ["Exit", "Running"],
                             "or_addresses": ["185.220.101.10:443", "[2001:db8::1]:9001"],
                             "exit_addresses": ["185.220.101.10"],
                             "running": True}]},
                target_module="app.enrichment.providers.onionoo")
    prov = onionoo.OnionooProvider(EnrichmentConfig(), _secrets())
    r = await prov.lookup("185.220.101.1", IndicatorKind.IP)
    assert r.ok and r.score == 0 and r.raw["tor_relay"] is False
    assert r.tags == []
    # The IPv6 or_address form ("[addr]:port") still exact-matches correctly.
    r6 = await prov.lookup("2001:db8::1", IndicatorKind.IP)
    assert r6.ok and r6.score == 40 and "tor_exit" in r6.tags


# --------------------------------------------------------------------------- #
# Spamhaus ZEN/DBL — keyless DNS, default OFF; return-code discipline
# --------------------------------------------------------------------------- #
async def test_spamhaus_xbl_listing_is_malicious(monkeypatch) -> None:
    from app.enrichment.providers import spamhaus

    monkeypatch.setattr(spamhaus, "_query_dnsbl", lambda name: "127.0.0.4")
    prov = spamhaus.SpamhausProvider(EnrichmentConfig(use_spamhaus=True), _secrets())
    r = await prov.lookup("203.0.113.5", IndicatorKind.IP)
    assert r.ok and r.score == 90 and r.malicious is True
    assert "xbl" in r.tags


async def test_spamhaus_pbl_is_policy_context_not_malice(monkeypatch) -> None:
    from app.enrichment.providers import spamhaus

    monkeypatch.setattr(spamhaus, "_query_dnsbl", lambda name: "127.0.0.10")
    prov = spamhaus.SpamhausProvider(EnrichmentConfig(use_spamhaus=True), _secrets())
    r = await prov.lookup("198.51.100.20", IndicatorKind.IP)
    # PBL = residential-policy listing — context, NEVER malicious (#3).
    assert r.ok and r.score == 25 and r.malicious is False
    assert "pbl_policy" in r.tags


async def test_spamhaus_error_codes_are_no_data_never_listed(monkeypatch) -> None:
    from app.enrichment.providers import spamhaus

    # 127.255.255.x = open-resolver refusal / over quota — MUST be no-data.
    monkeypatch.setattr(spamhaus, "_query_dnsbl", lambda name: "127.255.255.254")
    prov = spamhaus.SpamhausProvider(EnrichmentConfig(use_spamhaus=True), _secrets())
    r = await prov.lookup("192.0.2.33", IndicatorKind.IP)
    assert r.ok and r.score == 0 and r.malicious is False
    assert r.raw["refused"] is True and r.raw["listed"] is False


async def test_spamhaus_nxdomain_is_clean_and_dbl_for_domains(monkeypatch) -> None:
    from app.enrichment.providers import spamhaus

    monkeypatch.setattr(spamhaus, "_query_dnsbl", lambda name: None)
    prov = spamhaus.SpamhausProvider(EnrichmentConfig(use_spamhaus=True), _secrets())
    r = await prov.lookup("192.0.2.1", IndicatorKind.IP)
    assert r.ok and r.score == 0 and r.raw["listed"] is False

    seen: dict[str, str] = {}

    def fake_q(name: str) -> str:
        seen["name"] = name
        return "127.0.1.4"  # DBL phishing

    monkeypatch.setattr(spamhaus, "_query_dnsbl", fake_q)
    r2 = await prov.lookup("phish.example", IndicatorKind.DOMAIN)
    assert seen["name"] == "phish.example.dbl.spamhaus.org"
    assert r2.ok and r2.score == 85 and r2.malicious is True
    assert "dbl:phishing" in r2.tags


async def test_spamhaus_dbl_abused_legit_stays_context(monkeypatch) -> None:
    from app.enrichment.providers import spamhaus

    monkeypatch.setattr(spamhaus, "_query_dnsbl", lambda name: "127.0.1.102")
    prov = spamhaus.SpamhausProvider(EnrichmentConfig(use_spamhaus=True), _secrets())
    r = await prov.lookup("legit-but-abused.example", IndicatorKind.DOMAIN)
    assert r.ok and r.score == 40 and r.malicious is False
    assert "dbl:abused_legit" in r.tags


# --------------------------------------------------------------------------- #
# Team Cymru MHR — keyless DNS hash verdict, default OFF
# --------------------------------------------------------------------------- #
async def test_cymru_mhr_listed_hash_is_known_malware(monkeypatch) -> None:
    from app.enrichment.providers import cymru_mhr

    monkeypatch.setattr(cymru_mhr, "_query_mhr", lambda h: "127.0.0.2")
    prov = cymru_mhr.CymruMHRProvider(EnrichmentConfig(use_cymru_mhr=True), _secrets())
    r = await prov.lookup("d41d8cd98f00b204e9800998ecf8427e", IndicatorKind.FILE_HASH)
    # A listing IS a verdict feed → 90, malicious.
    assert r.ok and r.score == 90 and r.malicious is True
    assert "known_malware" in r.tags


async def test_cymru_mhr_nxdomain_clean_and_sha256_unsupported(monkeypatch) -> None:
    from app.enrichment.providers import cymru_mhr

    monkeypatch.setattr(cymru_mhr, "_query_mhr", lambda h: None)
    prov = cymru_mhr.CymruMHRProvider(EnrichmentConfig(use_cymru_mhr=True), _secrets())
    r = await prov.lookup("a" * 40, IndicatorKind.FILE_HASH)
    assert r.ok and r.score == 0 and r.raw["listed"] is False
    # SHA-256 is not in the MHR zone — neutral 'unsupported', not an error.
    r2 = await prov.lookup("a" * 64, IndicatorKind.FILE_HASH)
    assert r2.ok and r2.score == 0 and r2.raw["supported"] is False


# --------------------------------------------------------------------------- #
# Robtex — keyless passive-DNS context, default OFF, score always 0
# --------------------------------------------------------------------------- #
async def test_robtex_is_pure_context_score_zero(monkeypatch) -> None:
    from app.enrichment.providers import robtex

    _patch_http(monkeypatch,
                {"as": 64500, "asname": "EXAMPLE-AS", "country": "SE",
                 "pas": [{"o": "evil.example"}, {"o": "more.example"}]},
                target_module="app.enrichment.providers.robtex")
    prov = robtex.RobtexProvider(EnrichmentConfig(use_robtex=True), _secrets())
    r = await prov.lookup("192.0.2.55", IndicatorKind.IP)
    assert r.ok and r.score == 0 and r.malicious is False
    assert "pdns_domains:2" in r.tags
    assert "evil.example" in r.raw["pdns_domains"]


async def test_robtex_unreachable_degrades_to_no_data(monkeypatch) -> None:
    from app.enrichment.providers import robtex

    _patch_http(monkeypatch, None, target_module="app.enrichment.providers.robtex")
    prov = robtex.RobtexProvider(EnrichmentConfig(use_robtex=True), _secrets())
    r = await prov.lookup("192.0.2.56", IndicatorKind.IP)
    assert r.ok and r.score == 0 and not r.error


# --------------------------------------------------------------------------- #
# crt.sh — keyless CT context, default OFF, capped at 20
# --------------------------------------------------------------------------- #
async def test_crt_sh_recent_first_cert_bumps_within_cap(monkeypatch) -> None:
    from datetime import datetime, timedelta, timezone

    from app.enrichment.providers import crt_sh

    recent = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    _patch_http(monkeypatch,
                [{"entry_timestamp": recent, "issuer_name": "C=US, O=Let's Encrypt"}],
                target_module="app.enrichment.providers.crt_sh")
    prov = crt_sh.CrtShProvider(EnrichmentConfig(use_crt_sh=True), _secrets())
    r = await prov.lookup("brand-new.example", IndicatorKind.DOMAIN)
    # Context bump only — 20, never malicious (#3).
    assert r.ok and r.score == 20 and r.malicious is False
    assert "first_cert_recent" in r.tags and r.raw["certificates"] == 1


async def test_crt_sh_old_history_and_no_certs_are_zero(monkeypatch) -> None:
    from app.enrichment.providers import crt_sh

    _patch_http(monkeypatch, [{"entry_timestamp": "2019-05-01T00:00:00"}],
                target_module="app.enrichment.providers.crt_sh")
    prov = crt_sh.CrtShProvider(EnrichmentConfig(use_crt_sh=True), _secrets())
    r = await prov.lookup("old.example", IndicatorKind.DOMAIN)
    assert r.ok and r.score == 0
    _patch_http(monkeypatch, [], target_module="app.enrichment.providers.crt_sh")
    r2 = await prov.lookup("nocerts.example", IndicatorKind.DOMAIN)
    assert r2.ok and r2.score == 0 and r2.raw["certificates"] == 0


# --------------------------------------------------------------------------- #
# CrowdSec CTI — key-gated graded reputation
# --------------------------------------------------------------------------- #
async def test_crowdsec_malicious_reputation_scoring(monkeypatch) -> None:
    from app.enrichment.providers import crowdsec

    calls = _patch_http(monkeypatch,
                        {"reputation": "malicious",
                         "scores": {"overall": {"total": 4}},
                         "behaviors": [{"name": "http:bruteforce", "label": "HTTP Bruteforce"}],
                         "background_noise_score": 7,
                         "location": {"country": "CN"}},
                        target_module="app.enrichment.providers.crowdsec")
    prov = crowdsec.CrowdSecProvider(EnrichmentConfig(use_crowdsec=True),
                                     _secrets(crowdsec_api_key="k"))
    r = await prov.lookup("203.0.113.66", IndicatorKind.IP)
    assert r.ok and r.score == 85 and r.malicious is True
    assert "reputation:malicious" in r.tags and "http:bruteforce" in r.tags
    assert calls[0]["headers"]["x-api-key"] == "k"


async def test_crowdsec_unknown_ip_and_missing_key(monkeypatch) -> None:
    from app.enrichment.providers import crowdsec

    _patch_http(monkeypatch, None, target_module="app.enrichment.providers.crowdsec")
    prov = crowdsec.CrowdSecProvider(EnrichmentConfig(use_crowdsec=True),
                                     _secrets(crowdsec_api_key="k"))
    r = await prov.lookup("192.0.2.90", IndicatorKind.IP)
    assert r.ok and r.score == 0 and r.raw["seen"] is False
    prov2 = crowdsec.CrowdSecProvider(EnrichmentConfig(use_crowdsec=True), _secrets())
    r2 = await prov2.lookup("192.0.2.90", IndicatorKind.IP)
    assert r2.ok is False and "no api key" in (r2.error or "")


async def test_crowdsec_transport_error_fails_open(monkeypatch) -> None:
    from app.enrichment.providers import crowdsec

    _patch_http_raises(monkeypatch, RuntimeError("boom"),
                       target_module="app.enrichment.providers.crowdsec")
    prov = crowdsec.CrowdSecProvider(EnrichmentConfig(use_crowdsec=True),
                                     _secrets(crowdsec_api_key="k"))
    r = await prov.lookup("192.0.2.91", IndicatorKind.IP)
    assert r.ok is False and "boom" in (r.error or "")


# --------------------------------------------------------------------------- #
# Google Safe Browsing — key-gated verdict feed
# --------------------------------------------------------------------------- #
async def test_google_safebrowsing_match_is_verdict(monkeypatch) -> None:
    from app.enrichment.providers import google_safebrowsing

    calls = _patch_http(monkeypatch,
                        {"matches": [{"threatType": "SOCIAL_ENGINEERING",
                                      "platformType": "ANY_PLATFORM",
                                      "threat": {"url": "http://phish.example/"}}]},
                        target_module="app.enrichment.providers.google_safebrowsing")
    prov = google_safebrowsing.GoogleSafeBrowsingProvider(
        EnrichmentConfig(use_google_safebrowsing=True),
        _secrets(google_safebrowsing_api_key="gsb-key"))
    r = await prov.lookup("http://phish.example/", IndicatorKind.URL)
    assert r.ok and r.score == 90 and r.malicious is True
    assert "threat:SOCIAL_ENGINEERING" in r.tags
    # The key rides as ?key= (Google convention) and the body carries the URL entry.
    assert calls[0]["params"] == {"key": "gsb-key"}
    assert calls[0]["json_body"]["threatInfo"]["threatEntries"] == [
        {"url": "http://phish.example/"}
    ]


async def test_google_safebrowsing_domain_no_match_and_missing_key(monkeypatch) -> None:
    from app.enrichment.providers import google_safebrowsing

    calls = _patch_http(monkeypatch, {},  # empty body = not listed
                        target_module="app.enrichment.providers.google_safebrowsing")
    prov = google_safebrowsing.GoogleSafeBrowsingProvider(
        EnrichmentConfig(use_google_safebrowsing=True),
        _secrets(google_safebrowsing_api_key="k"))
    r = await prov.lookup("clean.example", IndicatorKind.DOMAIN)
    assert r.ok and r.score == 0 and r.malicious is False
    # A bare domain is submitted as a URL entry.
    assert calls[0]["json_body"]["threatInfo"]["threatEntries"] == [
        {"url": "http://clean.example/"}
    ]
    prov2 = google_safebrowsing.GoogleSafeBrowsingProvider(
        EnrichmentConfig(use_google_safebrowsing=True), _secrets())
    r2 = await prov2.lookup("x.example", IndicatorKind.DOMAIN)
    assert r2.ok is False and "no api key" in (r2.error or "")


# --------------------------------------------------------------------------- #
# IPQualityScore — key-gated graded fraud score; path-key never leaks
# --------------------------------------------------------------------------- #
async def test_ipqualityscore_fraud_score_direct_map(monkeypatch) -> None:
    from app.enrichment.providers import ipqualityscore

    _patch_http(monkeypatch,
                {"success": True, "fraud_score": 92, "proxy": True, "vpn": False,
                 "tor": False, "recent_abuse": True, "country_code": "US"},
                target_module="app.enrichment.providers.ipqualityscore")
    prov = ipqualityscore.IPQualityScoreProvider(
        EnrichmentConfig(use_ipqualityscore=True), _secrets(ipqualityscore_api_key="k"))
    r = await prov.lookup("203.0.113.77", IndicatorKind.IP)
    assert r.ok and r.score == 92 and r.malicious is True
    assert "proxy" in r.tags and "recent_abuse" in r.tags


async def test_ipqualityscore_low_score_and_missing_key(monkeypatch) -> None:
    from app.enrichment.providers import ipqualityscore

    _patch_http(monkeypatch, {"success": True, "fraud_score": 5},
                target_module="app.enrichment.providers.ipqualityscore")
    prov = ipqualityscore.IPQualityScoreProvider(
        EnrichmentConfig(use_ipqualityscore=True), _secrets(ipqualityscore_api_key="k"))
    r = await prov.lookup("198.51.100.4", IndicatorKind.IP)
    assert r.ok and r.score == 5 and r.malicious is False
    prov2 = ipqualityscore.IPQualityScoreProvider(
        EnrichmentConfig(use_ipqualityscore=True), _secrets())
    r2 = await prov2.lookup("198.51.100.4", IndicatorKind.IP)
    assert r2.ok is False and "no api key" in (r2.error or "")


async def test_ipqualityscore_http_error_never_leaks_path_key(monkeypatch) -> None:
    from app.enrichment.providers import ipqualityscore

    secret = "IPQS-PATH-SECRET-42"

    def raise_status(url, **kwargs):  # noqa: ANN001
        req = httpx.Request("GET", url)
        resp = httpx.Response(403, request=req)
        raise httpx.HTTPStatusError(f"HTTP 403 for {url}", request=req, response=resp)

    _patch_http(monkeypatch, raise_status,
                target_module="app.enrichment.providers.ipqualityscore")
    prov = ipqualityscore.IPQualityScoreProvider(
        EnrichmentConfig(use_ipqualityscore=True),
        _secrets(ipqualityscore_api_key=secret))
    r = await prov.lookup("203.0.113.1", IndicatorKind.IP)
    # The key lives in the URL PATH — the sanitised re-raise must scrub it.
    assert r.ok is False
    assert secret not in (r.error or "")
    assert "403" in (r.error or "")


async def test_ipqualityscore_success_false_is_generic_error(monkeypatch) -> None:
    from app.enrichment.providers import ipqualityscore

    _patch_http(monkeypatch, {"success": False, "message": "invalid key SECRET-XYZ"},
                target_module="app.enrichment.providers.ipqualityscore")
    prov = ipqualityscore.IPQualityScoreProvider(
        EnrichmentConfig(use_ipqualityscore=True), _secrets(ipqualityscore_api_key="k"))
    r = await prov.lookup("203.0.113.2", IndicatorKind.IP)
    assert r.ok is False and "SECRET-XYZ" not in (r.error or "")


# --------------------------------------------------------------------------- #
# ipdata — key-gated threat + geo
# --------------------------------------------------------------------------- #
async def test_ipdata_known_attacker_scores_60(monkeypatch) -> None:
    from app.enrichment.providers import ipdata

    _patch_http(monkeypatch,
                {"threat": {"is_known_attacker": True, "is_tor": True,
                            "blocklists": [{"name": "ET-block"}]},
                 "country_code": "RO", "asn": {"asn": "AS9009", "name": "M247"}},
                target_module="app.enrichment.providers.ipdata")
    prov = ipdata.IPDataProvider(EnrichmentConfig(use_ipdata=True),
                                 _secrets(ipdata_api_key="k"))
    r = await prov.lookup("203.0.113.99", IndicatorKind.IP)
    assert r.ok and r.score == 60 and r.malicious is True
    assert "known_attacker" in r.tags and "blocklist:ET-block" in r.tags


async def test_ipdata_anonymity_only_stays_context(monkeypatch) -> None:
    from app.enrichment.providers import ipdata

    _patch_http(monkeypatch, {"threat": {"is_tor": True}},
                target_module="app.enrichment.providers.ipdata")
    prov = ipdata.IPDataProvider(EnrichmentConfig(use_ipdata=True),
                                 _secrets(ipdata_api_key="k"))
    r = await prov.lookup("198.51.100.11", IndicatorKind.IP)
    assert r.ok and r.score == 40 and r.malicious is False
    prov2 = ipdata.IPDataProvider(EnrichmentConfig(use_ipdata=True), _secrets())
    r2 = await prov2.lookup("198.51.100.11", IndicatorKind.IP)
    assert r2.ok is False and "no api key" in (r2.error or "")


# --------------------------------------------------------------------------- #
# APIVoid — key-gated detection ratio
# --------------------------------------------------------------------------- #
async def test_apivoid_detection_ratio_maps_like_virustotal(monkeypatch) -> None:
    from app.enrichment.providers import apivoid

    _patch_http(monkeypatch,
                {"data": {"report": {"blacklists": {"detections": 60, "engines_count": 80}}}},
                target_module="app.enrichment.providers.apivoid")
    prov = apivoid.APIVoidProvider(EnrichmentConfig(use_apivoid=True),
                                   _secrets(apivoid_api_key="k"))
    r = await prov.lookup("203.0.113.44", IndicatorKind.IP)
    assert r.ok and r.score == 75 and r.malicious is True
    assert "detections:60/80" in r.tags


async def test_apivoid_low_ratio_clean_and_missing_key(monkeypatch) -> None:
    from app.enrichment.providers import apivoid

    _patch_http(monkeypatch,
                {"data": {"report": {"blacklists": {"detections": 2, "engines_count": 80}}}},
                target_module="app.enrichment.providers.apivoid")
    prov = apivoid.APIVoidProvider(EnrichmentConfig(use_apivoid=True),
                                   _secrets(apivoid_api_key="k"))
    r = await prov.lookup("bad.example", IndicatorKind.DOMAIN)
    assert r.ok and r.score == 2 and r.malicious is False
    prov2 = apivoid.APIVoidProvider(EnrichmentConfig(use_apivoid=True), _secrets())
    r2 = await prov2.lookup("bad.example", IndicatorKind.DOMAIN)
    assert r2.ok is False and "no api key" in (r2.error or "")


# --------------------------------------------------------------------------- #
# Maltiverse — key-gated classification
# --------------------------------------------------------------------------- #
async def test_maltiverse_malicious_classification(monkeypatch) -> None:
    from app.enrichment.providers import maltiverse

    calls = _patch_http(monkeypatch,
                        {"classification": "malicious",
                         "blacklist": [{"source": "Botnet-C2-feed", "description": "C2"}],
                         "country_code": "RU", "tag": ["c2"]},
                        target_module="app.enrichment.providers.maltiverse")
    prov = maltiverse.MaltiverseProvider(EnrichmentConfig(use_maltiverse=True),
                                         _secrets(maltiverse_api_key="mk"))
    r = await prov.lookup("203.0.113.13", IndicatorKind.IP)
    assert r.ok and r.score == 90 and r.malicious is True
    assert "classification:malicious" in r.tags
    assert calls[0]["headers"]["Authorization"] == "Bearer mk"


async def test_maltiverse_neutral_unknown_and_non_sha256_hash(monkeypatch) -> None:
    from app.enrichment.providers import maltiverse

    _patch_http(monkeypatch, {"classification": "neutral"},
                target_module="app.enrichment.providers.maltiverse")
    prov = maltiverse.MaltiverseProvider(EnrichmentConfig(use_maltiverse=True),
                                         _secrets(maltiverse_api_key="k"))
    r = await prov.lookup("neutral.example", IndicatorKind.DOMAIN)
    assert r.ok and r.score == 0 and r.malicious is False
    # The sample endpoint is SHA-256-keyed: an MD5 is a neutral 'unsupported'.
    r2 = await prov.lookup("d41d8cd98f00b204e9800998ecf8427e", IndicatorKind.FILE_HASH)
    assert r2.ok and r2.score == 0 and r2.raw["supported"] is False
    prov3 = maltiverse.MaltiverseProvider(EnrichmentConfig(use_maltiverse=True), _secrets())
    r3 = await prov3.lookup("x.example", IndicatorKind.DOMAIN)
    assert r3.ok is False and "no api key" in (r3.error or "")


# --------------------------------------------------------------------------- #
# SecurityTrails — key-gated pure domain context, score always 0
# --------------------------------------------------------------------------- #
async def test_securitytrails_is_pure_context(monkeypatch) -> None:
    from app.enrichment.providers import securitytrails

    calls = _patch_http(monkeypatch,
                        {"current_dns": {"a": {"values": [{"ip": "192.0.2.10"}]},
                                         "mx": {"values": []},
                                         "ns": {"values": [{"nameserver": "ns1.x"}]}},
                         "subdomain_count": 2, "apex_domain": "phish.example"},
                        target_module="app.enrichment.providers.securitytrails")
    prov = securitytrails.SecurityTrailsProvider(
        EnrichmentConfig(use_securitytrails=True), _secrets(securitytrails_api_key="st"))
    r = await prov.lookup("phish.example", IndicatorKind.DOMAIN)
    assert r.ok and r.score == 0 and r.malicious is False
    assert "no_mx" in r.tags and "resolves:192.0.2.10" in r.tags
    assert calls[0]["headers"]["APIKEY"] == "st"


async def test_securitytrails_missing_key_fails_open() -> None:
    from app.enrichment.providers import securitytrails

    prov = securitytrails.SecurityTrailsProvider(
        EnrichmentConfig(use_securitytrails=True), _secrets())
    r = await prov.lookup("x.example", IndicatorKind.DOMAIN)
    assert r.ok is False and "no api key" in (r.error or "")


# --------------------------------------------------------------------------- #
# Criminal IP — key-gated graded ladder
# --------------------------------------------------------------------------- #
async def test_criminalip_critical_inbound_scores_100(monkeypatch) -> None:
    from app.enrichment.providers import criminalip

    calls = _patch_http(monkeypatch,
                        {"score": {"inbound": "Critical", "outbound": "Low"},
                         "issues": {"is_vpn": True, "is_scanner": True, "is_snort": False}},
                        target_module="app.enrichment.providers.criminalip")
    prov = criminalip.CriminalIPProvider(EnrichmentConfig(use_criminalip=True),
                                         _secrets(criminalip_api_key="ck"))
    r = await prov.lookup("203.0.113.21", IndicatorKind.IP)
    assert r.ok and r.score == 100 and r.malicious is True
    assert "inbound:5" in r.tags and "is_scanner" in r.tags
    assert calls[0]["headers"]["x-api-key"] == "ck"


async def test_criminalip_moderate_stays_below_the_cut(monkeypatch) -> None:
    from app.enrichment.providers import criminalip

    _patch_http(monkeypatch, {"score": {"inbound": 3, "outbound": 1}},
                target_module="app.enrichment.providers.criminalip")
    prov = criminalip.CriminalIPProvider(EnrichmentConfig(use_criminalip=True),
                                         _secrets(criminalip_api_key="k"))
    r = await prov.lookup("198.51.100.30", IndicatorKind.IP)
    # Moderate (3) maps to 40 — never alone across the 50 cut (#3).
    assert r.ok and r.score == 40 and r.malicious is False
    prov2 = criminalip.CriminalIPProvider(EnrichmentConfig(use_criminalip=True), _secrets())
    r2 = await prov2.lookup("198.51.100.30", IndicatorKind.IP)
    assert r2.ok is False and "no api key" in (r2.error or "")


# --------------------------------------------------------------------------- #
# Netlas — key-gated exposure context
# --------------------------------------------------------------------------- #
async def test_netlas_profile_is_capped_exposure_context(monkeypatch) -> None:
    from app.enrichment.providers import netlas

    calls = _patch_http(monkeypatch,
                        {"dns": {"a": ["192.0.2.61"]},
                         "related_domains": ["a.example", "b.example"],
                         "whois": {"registrar": "Example Registrar Inc"}},
                        target_module="app.enrichment.providers.netlas")
    prov = netlas.NetlasProvider(EnrichmentConfig(use_netlas=True),
                                 _secrets(netlas_api_key="nk"))
    r = await prov.lookup("campaign.example", IndicatorKind.DOMAIN)
    assert r.ok and r.score == 20 and r.malicious is False
    assert "related_domains:2" in r.tags
    assert calls[0]["headers"]["X-API-Key"] == "nk"


async def test_netlas_empty_profile_and_missing_key(monkeypatch) -> None:
    from app.enrichment.providers import netlas

    _patch_http(monkeypatch, {}, target_module="app.enrichment.providers.netlas")
    prov = netlas.NetlasProvider(EnrichmentConfig(use_netlas=True),
                                 _secrets(netlas_api_key="k"))
    r = await prov.lookup("192.0.2.62", IndicatorKind.IP)
    assert r.ok and r.score == 0 and r.raw["seen"] is False
    prov2 = netlas.NetlasProvider(EnrichmentConfig(use_netlas=True), _secrets())
    r2 = await prov2.lookup("192.0.2.62", IndicatorKind.IP)
    assert r2.ok is False and "no api key" in (r2.error or "")


# --------------------------------------------------------------------------- #
# Hybrid Analysis — key-gated sandbox verdict
# --------------------------------------------------------------------------- #
async def test_hybrid_analysis_malicious_verdict(monkeypatch) -> None:
    from app.enrichment.providers import hybrid_analysis

    calls = _patch_http(monkeypatch,
                        [{"verdict": "malicious", "threat_score": 100,
                          "vx_family": "RedLine Stealer"}],
                        target_module="app.enrichment.providers.hybrid_analysis")
    prov = hybrid_analysis.HybridAnalysisProvider(
        EnrichmentConfig(use_hybrid_analysis=True),
        _secrets(hybrid_analysis_api_key="ha"))
    r = await prov.lookup("a" * 64, IndicatorKind.FILE_HASH)
    assert r.ok and r.score >= 90 and r.malicious is True
    assert "family:RedLine Stealer" in r.tags
    assert calls[0]["headers"]["api-key"] == "ha"
    assert calls[0]["headers"]["User-Agent"] == "Falcon Sandbox"
    assert calls[0]["data"] == {"hash": "a" * 64}


async def test_hybrid_analysis_suspicious_unknown_and_missing_key(monkeypatch) -> None:
    from app.enrichment.providers import hybrid_analysis

    _patch_http(monkeypatch, [{"verdict": "suspicious", "threat_score": 40}],
                target_module="app.enrichment.providers.hybrid_analysis")
    prov = hybrid_analysis.HybridAnalysisProvider(
        EnrichmentConfig(use_hybrid_analysis=True),
        _secrets(hybrid_analysis_api_key="k"))
    r = await prov.lookup("b" * 64, IndicatorKind.FILE_HASH)
    assert r.ok and r.score == 60 and r.malicious is True
    _patch_http(monkeypatch, [], target_module="app.enrichment.providers.hybrid_analysis")
    r2 = await prov.lookup("c" * 64, IndicatorKind.FILE_HASH)
    assert r2.ok and r2.score == 0 and r2.raw["seen"] is False
    prov3 = hybrid_analysis.HybridAnalysisProvider(
        EnrichmentConfig(use_hybrid_analysis=True), _secrets())
    r3 = await prov3.lookup("d" * 64, IndicatorKind.FILE_HASH)
    assert r3.ok is False and "no api key" in (r3.error or "")


# --------------------------------------------------------------------------- #
# MetaDefender — key-gated multi-engine ratio
# --------------------------------------------------------------------------- #
async def test_metadefender_detection_ratio(monkeypatch) -> None:
    from app.enrichment.providers import metadefender

    calls = _patch_http(monkeypatch,
                        {"scan_results": {"total_detected_avs": 35, "total_avs": 70,
                                          "scan_all_result_a": "Infected",
                                          "scan_details": {"EngineA": {"threat_found": "Trojan.X"}}}},
                        target_module="app.enrichment.providers.metadefender")
    prov = metadefender.MetaDefenderProvider(EnrichmentConfig(use_metadefender=True),
                                             _secrets(metadefender_api_key="md"))
    r = await prov.lookup("e" * 64, IndicatorKind.FILE_HASH)
    assert r.ok and r.score == 50 and r.malicious is True
    assert "detections:35/70" in r.tags and "Trojan.X" in r.tags
    assert calls[0]["headers"]["apikey"] == "md"


async def test_metadefender_never_scanned_and_missing_key(monkeypatch) -> None:
    from app.enrichment.providers import metadefender

    _patch_http(monkeypatch, None, target_module="app.enrichment.providers.metadefender")
    prov = metadefender.MetaDefenderProvider(EnrichmentConfig(use_metadefender=True),
                                             _secrets(metadefender_api_key="k"))
    r = await prov.lookup("f" * 64, IndicatorKind.FILE_HASH)
    assert r.ok and r.score == 0 and r.raw["seen"] is False
    prov2 = metadefender.MetaDefenderProvider(EnrichmentConfig(use_metadefender=True), _secrets())
    r2 = await prov2.lookup("f" * 64, IndicatorKind.FILE_HASH)
    assert r2.ok is False and "no api key" in (r2.error or "")


# --------------------------------------------------------------------------- #
# EmailRep — key-gated email sender reputation
# --------------------------------------------------------------------------- #
async def test_emailrep_malicious_activity_scores_60(monkeypatch) -> None:
    from app.enrichment.providers import emailrep

    calls = _patch_http(monkeypatch,
                        {"email": "ceo@fake.example", "reputation": "none",
                         "suspicious": True, "references": 3,
                         "details": {"malicious_activity": True,
                                     "credentials_leaked": True,
                                     "days_since_domain_creation": 4,
                                     "profiles": []}},
                        target_module="app.enrichment.providers.emailrep")
    prov = emailrep.EmailRepProvider(EnrichmentConfig(use_emailrep=True),
                                     _secrets(emailrep_api_key="er"))
    r = await prov.lookup("ceo@fake.example", IndicatorKind.EMAIL)
    assert r.ok and r.score == 60 and r.malicious is True
    assert "malicious_activity" in r.tags and "credentials_leaked" in r.tags
    assert calls[0]["headers"]["Key"] == "er"


async def test_emailrep_suspicious_only_clean_and_missing_key(monkeypatch) -> None:
    from app.enrichment.providers import emailrep

    _patch_http(monkeypatch,
                {"reputation": "low", "suspicious": True, "details": {}},
                target_module="app.enrichment.providers.emailrep")
    prov = emailrep.EmailRepProvider(EnrichmentConfig(use_emailrep=True),
                                     _secrets(emailrep_api_key="k"))
    r = await prov.lookup("odd@new.example", IndicatorKind.EMAIL)
    # Suspicious-only stays below the malicious cut.
    assert r.ok and r.score == 40 and r.malicious is False
    _patch_http(monkeypatch,
                {"reputation": "high", "suspicious": False,
                 "details": {"malicious_activity": False}},
                target_module="app.enrichment.providers.emailrep")
    r2 = await prov.lookup("real@corp.example", IndicatorKind.EMAIL)
    assert r2.ok and r2.score == 0 and r2.malicious is False
    prov3 = emailrep.EmailRepProvider(EnrichmentConfig(use_emailrep=True), _secrets())
    r3 = await prov3.lookup("x@y.example", IndicatorKind.EMAIL)
    assert r3.ok is False and "no api key" in (r3.error or "")


# --------------------------------------------------------------------------- #
# Score discipline sweep — no Round-11 CONTEXT provider can cross the 50 cut
# --------------------------------------------------------------------------- #
async def test_round11_context_providers_never_reach_the_malicious_cut(monkeypatch) -> None:
    """Adversarial payloads: even a maximally 'scary' response keeps every Round-11
    context provider below 50 and non-malicious (#3 — the legacy max() fusion)."""
    from app.enrichment.providers import (
        circl_hashlookup, crt_sh, dshield, netlas, onionoo, robtex, securitytrails,
    )

    checks = [
        (circl_hashlookup.CirclHashlookupProvider(EnrichmentConfig(), _secrets()),
         "app.enrichment.providers.circl_hashlookup",
         {"SHA-256": "a" * 64, "FileName": "evil.exe", "hashlookup:trust": 0},
         ("a" * 64, IndicatorKind.FILE_HASH)),
        (dshield.DShieldProvider(EnrichmentConfig(), _secrets()),
         "app.enrichment.providers.dshield",
         {"ip": {"count": 10**9, "attacks": 10**9, "threatfeeds": {"x": {}}}},
         ("203.0.113.1", IndicatorKind.IP)),
        (onionoo.OnionooProvider(EnrichmentConfig(), _secrets()),
         "app.enrichment.providers.onionoo",
         {"relays": [{"flags": ["Exit", "BadExit"], "running": True}]},
         ("203.0.113.2", IndicatorKind.IP)),
        (robtex.RobtexProvider(EnrichmentConfig(use_robtex=True), _secrets()),
         "app.enrichment.providers.robtex",
         {"pas": [{"o": f"d{i}.example"} for i in range(500)]},
         ("203.0.113.3", IndicatorKind.IP)),
        (crt_sh.CrtShProvider(EnrichmentConfig(use_crt_sh=True), _secrets()),
         "app.enrichment.providers.crt_sh",
         [{"entry_timestamp": "2099-01-01T00:00:00"}],
         ("x.example", IndicatorKind.DOMAIN)),
        (securitytrails.SecurityTrailsProvider(
            EnrichmentConfig(use_securitytrails=True), _secrets(securitytrails_api_key="k")),
         "app.enrichment.providers.securitytrails",
         {"current_dns": {"a": {"values": [{"ip": "1.2.3.4"}]}}, "subdomain_count": 99999},
         ("x.example", IndicatorKind.DOMAIN)),
        (netlas.NetlasProvider(EnrichmentConfig(use_netlas=True), _secrets(netlas_api_key="k")),
         "app.enrichment.providers.netlas",
         {"dns": {"a": ["1.2.3.4"]}, "related_domains": ["a"] * 1000,
          "whois": {"registrar": "X"}},
         ("x.example", IndicatorKind.DOMAIN)),
    ]
    for prov, module, payload, (value, kind) in checks:
        _patch_http(monkeypatch, payload, target_module=module)
        r = await prov.lookup(value, kind)
        assert r.ok, prov.name
        assert (r.score or 0) < 50, prov.name
        assert r.malicious is not True, prov.name


# --------------------------------------------------------------------------- #
# Router — the Round-11 manifest fields are serialised (setup_steps + example)
# --------------------------------------------------------------------------- #
@pytest.fixture
async def app_state():
    from app.es.fake import InMemoryESClient
    from app.state import AppState

    state = AppState(_secrets(es_store_enabled=False, redis_url=""), InMemoryESClient())
    await state.startup()
    try:
        yield state
    finally:
        await state.shutdown()


async def test_router_serialises_setup_steps_and_example(app_state) -> None:
    from app.api.routes_enrichment import list_enrichment_providers

    out = await list_enrichment_providers(state=app_state)
    by = {p["name"]: p for p in out["providers"]}
    # Every provider (old + new) carries a non-empty guide + example.
    for name, p in by.items():
        assert isinstance(p["setup_steps"], list) and p["setup_steps"], name
        assert all(isinstance(s, str) and s for s in p["setup_steps"]), name
        assert isinstance(p["example"], str) and p["example"], name
    # Spot-check: a Round-11 keyed provider names its env var in the steps.
    assert any("TLSOC_CROWDSEC_API_KEY" in s for s in by["crowdsec"]["setup_steps"])
    # A keyless one explains there is nothing to configure.
    assert by["circl_hashlookup"]["keyless"] is True


# --------------------------------------------------------------------------- #
# Registry gating — Round-11 providers only fire when toggled (and keyed)
# --------------------------------------------------------------------------- #
def test_round11_providers_gated_by_toggle_and_key() -> None:
    from app.enrichment.registry import get_provider_registry

    reg = get_provider_registry()

    def selected(kind: IndicatorKind, cfg: EnrichmentConfig, secrets: Secrets) -> set[str]:
        return {c.name for c in reg.for_indicator(kind, cfg, secrets)}

    # Key-gated: toggle ON without a key → NOT selected; both → selected.
    assert "crowdsec" not in selected(IndicatorKind.IP, EnrichmentConfig(use_crowdsec=True), _secrets())
    assert "crowdsec" in selected(
        IndicatorKind.IP, EnrichmentConfig(use_crowdsec=True), _secrets(crowdsec_api_key="k"))
    # Keyless default-OFF: toggle OFF → not selected; ON → selected with no key.
    assert "spamhaus" not in selected(IndicatorKind.IP, EnrichmentConfig(), _secrets())
    assert "spamhaus" in selected(IndicatorKind.IP, EnrichmentConfig(use_spamhaus=True), _secrets())
    # Keyless default-ON fire out of the box.
    assert {"dshield", "onionoo"}.issubset(selected(IndicatorKind.IP, EnrichmentConfig(), _secrets()))
    assert "circl_hashlookup" in selected(IndicatorKind.FILE_HASH, EnrichmentConfig(), _secrets())
