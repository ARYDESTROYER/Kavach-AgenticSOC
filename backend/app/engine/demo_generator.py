"""Deterministic, seeded synthetic data generator for Demo Mode (Wave 5).

This module fabricates a believable SOC dataset for the demo tenant: a fixed
fictional fintech org (**LumenPay Financial**, a Lentra-style digital lender —
employees, laptops/phones, a server fleet, an internet-facing web-app tier, a
corporate /16), a benign baseline (diurnal Poisson volume + Zipf entity
popularity + a 70/22/7/1 severity pyramid) and a roster of named MITRE ATT&CK
STORYLINES, plus a historical spread of finished Cases for the "old data" view
and a tight "just happened" pre-seed window (recent cases + already-processed
events).

The synthetic estate is partitioned into three **segments** that map to the three
demo sources — ``siem`` (internet-facing financial web app), ``xdr`` (cross-host
correlation over the server fleet) and ``edr`` (employee laptops & phones). The
generator functions accept an optional ``segment`` to draw only that segment's
rule/host pool; ``segment=None`` keeps the pre-overhaul undifferentiated behaviour.

Everything is DETERMINISTIC for a given seed: a caller-supplied seeded
``random.Random`` is the ONLY randomness source (no ``Math.random`` / wall-clock
in the seeded paths), so the same seed yields byte-identical events and the same
historical case spread. Synthetic log/case text is DATA (#9) — it is plain text,
never trusted as instructions.

The generator emits ECS-shaped ``_source`` documents (matching the suite's default
field mapping) wrapped as ES "hits" (``{_id,_index,_source}``); callers project
them to :class:`RawEvent` (the connector path) or :class:`OCSFEvent`
(``ecs_to_ocsf``) exactly as a real Elasticsearch source would. It writes NOTHING
and touches NO real store — it is a pure value producer.

MITRE constraint: every technique id used in a storyline/history template is
validated against the bundled enterprise ATT&CK corpus
(``app/threat/mitre_techniques.json``, 697 techniques). Mobile-only ids (T14xx /
T16xx) are NOT in that corpus and are deliberately avoided here.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, NamedTuple

from ..build_identity import current_record_provenance
from ..config import Preferences
from ..constants import CaseStatus, DecisionBy, Disposition, EntityType, SourceSurface, Verdict
from ..models import (
    Case,
    CaseComment,
    Entity,
    EvidenceItem,
    FeedbackEntry,
    RawEvent,
    RiskBreakdown,
    StatusHistoryEntry,
)
from ..ocsf import OCSFEvent, ecs_to_ocsf

DEMO_SOURCE_IDS: tuple[str, ...] = (
    "demo-splunk", "demo-qradar", "demo-wazuh", "demo-syslog", "demo-entra-id",
)
DEMO_SOURCE_NAMES: dict[str, str] = {
    "demo-splunk": "Splunk Enterprise Security (HEC)",
    "demo-qradar": "IBM QRadar SIEM",
    "demo-wazuh": "Wazuh Manager (endpoint telemetry)",
    "demo-syslog": "Network & Linux (RFC 5424 Syslog)",
    "demo-entra-id": "Microsoft Entra ID / Active Directory",
}
DEMO_SOURCE_ID = DEMO_SOURCE_IDS[0]
DEMO_SOURCE_NAME = DEMO_SOURCE_NAMES[DEMO_SOURCE_ID]
DEMO_INDEX = "tlsoc-demo-logs"

# Legacy narrative segments used to build seeded history. At runtime they resolve
# through ``NATIVE_RULE_TO_STORY``/the native source aliases; they never enter
# ``Preferences.sources`` and are not the five rows shown by demo_sources_overlay().
SEGMENTS: tuple[str, ...] = ("siem", "xdr", "edr")
SEGMENT_SOURCE_IDS: dict[str, str] = {
    "siem": "demo-splunk",
    "xdr": "demo-qradar",
    "edr": "demo-wazuh",
}
SEGMENT_SOURCE_NAMES: dict[str, str] = {
    "siem": DEMO_SOURCE_NAMES["demo-splunk"],
    "xdr": DEMO_SOURCE_NAMES["demo-qradar"],
    "edr": DEMO_SOURCE_NAMES["demo-wazuh"],
}
SEGMENT_CATEGORIES: dict[str, str] = {"siem": "siem", "xdr": "xdr", "edr": "edr"}

_MS_PER_HOUR = 3_600_000
_MS_PER_DAY = 86_400_000


# --------------------------------------------------------------------------- #
# Fixed fictional org fixture — LumenPay Financial (fintech digital lender)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Employee:
    user: str
    display: str
    dept: str
    vip: bool = False


@dataclass(frozen=True)
class Host:
    name: str
    ip: str
    kind: str            # workstation | server | dc | vip_laptop | mobile
    criticality: float
    segment: str = ""    # "siem" | "xdr" | "edr" (which demo source owns it)


@dataclass(frozen=True)
class Org:
    name: str
    domain: str
    cidr: str            # corporate /16
    employees: list[Employee]
    hosts: list[Host]

    def host_by_kind(self, kind: str) -> Host | None:
        return next((h for h in self.hosts if h.kind == kind), None)

    def host_named(self, name: str) -> Host | None:
        return next((h for h in self.hosts if h.name == name), None)

    def segment_hosts(self, segment: str) -> list[Host]:
        """Every host owned by ``segment`` (empty when ``segment`` is unknown)."""
        return [h for h in self.hosts if h.segment == segment]


# Named employees (the EDR/XDR subjects the storylines target). The first six indices
# are addressed positionally by the storyline generators — keep the order stable.
_EMPLOYEE_SEED: tuple[tuple[str, str, str, bool], ...] = (
    ("pnair", "Priya Nair", "Loan Ops", False),         # [0] phishing target (flagship)
    ("rmenon", "Rohit Menon", "DevOps", False),          # [1] impossible-travel subject
    ("sgupta", "Sanjay Gupta", "IT / Helpdesk", False),  # [2]
    ("dsingh", "Deepa Singh", "Bank Ops (privileged)", True),   # [3] VIP
    ("svc_bureau", "Bureau Service Account", "Service", False),  # [4]
    ("akulkarni", "Aditya Kulkarni", "Finance", False),  # [5] insider-staging subject
    ("admin_ops", "Ops Admin", "Service", False),
    ("mgeorge", "Maya George", "Collections", False),
    ("trao", "Tarun Rao", "Underwriting", False),
    ("njoshi", "Neha Joshi", "Compliance", False),
    ("vpatel", "Vikram Patel", "Partnerships", False),
    ("ldsouza", "Lena D'Souza", "Customer Success", False),
)


def build_org(seed: int = 1337) -> Org:
    """Construct the fixed fictional LumenPay org deterministically from ``seed``.

    ~12 employees, ~42 hosts partitioned across three segments:
    * ``siem`` — the internet-facing web-app tier (borrower portal / partner APIs /
      bank-ops admin panel),
    * ``xdr`` — the internal server fleet + domain controllers (cross-host stories),
    * ``edr`` — employee laptops (``LP-LT-*``) + phones (``LP-MOB-*``).

    Two calls with the same seed yield the SAME org (host names/IPs/criticalities are
    derived, not randomly re-drawn each run beyond the seeded RNG)."""
    rng = random.Random(seed ^ 0x0C0FFEE)
    employees = [Employee(u, d, dept, vip) for (u, d, dept, vip) in _EMPLOYEE_SEED]

    hosts: list[Host] = []
    # SIEM segment — internet-facing financial web-app tier (app-tier /16 10.80.x).
    web_tier = [
        ("web-portal", "10.80.0.10", 85.0),      # portal.lumenpay.example (borrowers)
        ("web-apps", "10.80.0.11", 80.0),        # apps.lumenpay.example
        ("web-api", "10.80.0.12", 88.0),         # api.lumenpay.example (bureau/KYC)
        ("web-adminops", "10.80.0.13", 92.0),    # admin-ops.lumenpay.example
    ]
    for name, ip, crit in web_tier:
        hosts.append(Host(name, ip, "server", crit, segment="siem"))

    # XDR segment — internal server fleet + domain controllers (corp /16 10.20.x).
    hosts.append(Host("dc01", "10.20.0.10", "dc", 95.0, segment="xdr"))
    hosts.append(Host("dc02", "10.20.0.11", "dc", 90.0, segment="xdr"))
    server_roles = [
        ("sql01", 90.0), ("sql02", 82.0), ("appsrv01", 78.0), ("appsrv02", 75.0),
        ("bureau-gw", 84.0), ("vpn01", 85.0), ("jumpbox01", 85.0), ("backup01", 88.0),
    ]
    for i, (name, crit) in enumerate(server_roles):
        hosts.append(Host(name, f"10.20.1.{20 + i}", "server", crit, segment="xdr"))

    # EDR segment — employee laptops + phones.
    hosts.append(Host("LP-LT-DSINGH", "10.20.5.5", "vip_laptop", 92.0, segment="edr"))
    named_laptops = ["LP-LT-PNAIR", "LP-LT-RMENON", "LP-LT-AKULK", "LP-LT-SGUPTA"]
    for i, name in enumerate(named_laptops):
        crit = round(20.0 + rng.random() * 20.0, 1)
        hosts.append(Host(name, f"10.20.6.{10 + i}", "workstation", crit, segment="edr"))
    # A fleet of generic employee laptops to round out ~42 hosts.
    for i in range(23):
        octet4 = 30 + i
        crit = round(10.0 + rng.random() * 25.0, 1)
        hosts.append(Host(f"LP-WS-{i + 1:03d}", f"10.20.7.{octet4}", "workstation", crit, segment="edr"))
    # A few managed phones (mobile threat surface).
    for name, ip4 in (("LP-MOB-PNAIR", 21), ("LP-MOB-RMENON", 22), ("LP-MOB-DSINGH", 23)):
        hosts.append(Host(name, f"10.99.0.{ip4}", "mobile", 55.0, segment="edr"))

    return Org(
        name="LumenPay Financial",
        domain="lumenpay.example",
        cidr="10.20.0.0/16",
        employees=employees,
        hosts=hosts,
    )


# --------------------------------------------------------------------------- #
# Low-level event construction (ECS-shaped, matching default field mapping)
# --------------------------------------------------------------------------- #
def _iso(ts_millis: int) -> str:
    return datetime.fromtimestamp(ts_millis / 1000.0, tz=timezone.utc).isoformat()


def _hit(
    *,
    eid: str,
    ts_millis: int,
    rule: str,
    rule_name: str,
    severity: float,
    ip: str | None = None,
    user: str | None = None,
    host: str | None = None,
    action: str = "event",
    outcome: str = "success",
    message: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One ECS-shaped ES hit (``{_id,_index,_source}``). All values are synthetic
    DATA (#9). ``extra`` merges additional dotted-ish ECS sub-objects."""
    src: dict[str, Any] = {
        "@timestamp": _iso(ts_millis),
        "event": {"module": rule, "action": action, "outcome": outcome, "severity": severity},
        "rule": {"name": rule_name},
        "message": message or f"{rule_name}: {action} {outcome}",
    }
    if ip is not None:
        src["source"] = {"ip": ip}
    if user is not None:
        src["user"] = {"name": user}
    if host is not None:
        src.setdefault("host", {})["name"] = host
    if extra:
        for k, v in extra.items():
            if isinstance(v, dict) and isinstance(src.get(k), dict):
                src[k].update(v)
            else:
                src[k] = v
    return {"_id": eid, "_index": DEMO_INDEX, "_source": src}


# --------------------------------------------------------------------------- #
# Benign baseline
# --------------------------------------------------------------------------- #
# Diurnal envelope (relative event volume per hour-of-day, business-hours peak).
_DIURNAL = (
    0.15, 0.10, 0.08, 0.07, 0.07, 0.10,      # 00-05
    0.20, 0.45, 0.80, 1.00, 1.00, 0.95,      # 06-11
    0.70, 0.95, 1.00, 0.95, 0.85, 0.60,      # 12-17
    0.45, 0.35, 0.30, 0.25, 0.22, 0.18,      # 18-23
)

# Per-segment benign rule pools. Each tuple is (module, rule_name, action, outcome).
# The SIEM segment is web/WAF/app telemetry; XDR is identity/mail/cloud correlation;
# EDR is endpoint + mobile heartbeat. The union is the segment-agnostic fallback.
_SIEM_BENIGN_RULES: tuple[tuple[str, str, str, str], ...] = (
    ("web_portal_auth", "Borrower portal sign-in", "login", "success"),
    ("web_apache_access", "Web request", "request", "success"),
    ("waf_allow", "WAF allow", "allow", "success"),
    ("loan_api_access", "Loan API request", "request", "success"),
)
_XDR_BENIGN_RULES: tuple[tuple[str, str, str, str], ...] = (
    ("identity_signin", "Identity sign-in", "login", "success"),
    ("mail_auth", "Mail authentication", "login", "success"),
    ("cloud_audit", "Cloud control-plane audit", "read", "success"),
)
_EDR_BENIGN_RULES: tuple[tuple[str, str, str, str], ...] = (
    ("edr_heartbeat", "Endpoint telemetry", "heartbeat", "success"),
    ("edr_process", "Benign process start", "exec", "success"),
    ("mtd_heartbeat", "Mobile device check-in", "heartbeat", "success"),
)
_BENIGN_RULES: tuple[tuple[str, str, str, str], ...] = (
    _SIEM_BENIGN_RULES + _XDR_BENIGN_RULES + _EDR_BENIGN_RULES
)

_SEGMENT_RULES: dict[str, tuple[tuple[str, str, str, str], ...]] = {
    "siem": _SIEM_BENIGN_RULES,
    "xdr": _XDR_BENIGN_RULES,
    "edr": _EDR_BENIGN_RULES,
}


def _segment_rules(segment: str | None) -> list[tuple[str, str, str, str]]:
    """The benign rule pool for ``segment`` (or the full union when None/unknown)."""
    return list(_SEGMENT_RULES.get(segment or "", _BENIGN_RULES))


def _segment_hosts(org: Org, segment: str | None) -> list[Host]:
    """The host pool for ``segment`` (falls back to the laptop/VIP pool, matching the
    pre-overhaul behaviour, when ``segment`` is None/unknown/empty)."""
    if segment:
        hosts = org.segment_hosts(segment)
        if hosts:
            return hosts
    return [h for h in org.hosts if h.kind in ("workstation", "vip_laptop")]


def diurnal_weight(ts_millis: int) -> float:
    """The diurnal envelope multiplier for the hour-of-day at ``ts_millis``."""
    hour = datetime.fromtimestamp(ts_millis / 1000.0, tz=timezone.utc).hour
    return _DIURNAL[hour]


def _zipf_pick(rng: random.Random, items: list[Any]) -> Any:
    """Pick from ``items`` with a Zipf-ish popularity (item 0 most popular)."""
    n = len(items)
    weights = [1.0 / (i + 1) for i in range(n)]
    total = sum(weights)
    r = rng.random() * total
    acc = 0.0
    for it, w in zip(items, weights):
        acc += w
        if r <= acc:
            return it
    return items[-1]


def _severity_tier(rng: random.Random) -> float:
    """A 0..100 severity drawn from the 70/22/7/1 pyramid (info/low/med/high)."""
    r = rng.random()
    if r < 0.70:
        return round(5.0 + rng.random() * 15.0, 1)     # informational
    if r < 0.92:
        return round(25.0 + rng.random() * 20.0, 1)    # low
    if r < 0.99:
        return round(50.0 + rng.random() * 20.0, 1)    # medium
    return round(75.0 + rng.random() * 20.0, 1)        # high


def _benign_hit(
    rng: random.Random, org: Org, ts_millis: int, segment: str | None,
) -> dict[str, Any]:
    """One benign ECS hit at exactly ``ts_millis`` from ``segment``'s rule/host pool."""
    rule, rname, action, outcome = _zipf_pick(rng, _segment_rules(segment))
    emp = _zipf_pick(rng, org.employees)
    host = _zipf_pick(rng, _segment_hosts(org, segment))
    ip = f"10.20.{rng.randint(20, 40)}.{rng.randint(2, 250)}"
    sev = _severity_tier(rng)
    eid = f"demo-evt-{ts_millis}-{rng.randint(100000, 999999)}"
    return _hit(
        eid=eid, ts_millis=ts_millis, rule=rule, rule_name=rname, severity=sev,
        ip=ip, user=emp.user, host=host.name, action=action, outcome=outcome,
        message=f"{rname}: {emp.user} on {host.name} from {ip}",
    )


def generate_benign_batch(
    rng: random.Random, org: Org, ts_millis: int, count: int,
    segment: str | None = None,
) -> list[dict[str, Any]]:
    """A batch of ``count`` benign ECS hits at ~``ts_millis`` (jittered within the
    hour). Entity popularity is Zipf (a few chatty hosts/users), severity follows the
    pyramid. When ``segment`` is given the rule/host pool is restricted to it; None
    keeps the full union (pre-overhaul behaviour). Deterministic for a given ``rng`` +
    args."""
    out: list[dict[str, Any]] = []
    for _ in range(max(0, count)):
        jitter = rng.randint(0, _MS_PER_HOUR - 1)
        out.append(_benign_hit(rng, org, ts_millis + jitter, segment))
    return out


def generate_recent_events(
    rng: random.Random, org: Org, *, from_millis: int, to_millis: int, count: int,
    segments: tuple[str, ...] = SEGMENTS,
) -> list[dict[str, Any]]:
    """``count`` benign ECS hits whose timestamps land STRICTLY inside
    ``[from_millis, to_millis)``, round-robin across ``segments``.

    Unlike :func:`generate_benign_batch` (which jitters up to an hour forward for the
    hourly-bucket poll surface), this places each event at an explicit in-window
    timestamp — used by the pre-seed so the ~100 "already processed" events actually
    fall in the tight recent window. Deterministic for a given ``rng`` + args."""
    out: list[dict[str, Any]] = []
    span = max(1, to_millis - from_millis)
    segs = list(segments) or [None]  # type: ignore[list-item]
    for i in range(max(0, count)):
        seg = segs[i % len(segs)]
        ts = from_millis + rng.randint(0, span - 1)
        out.append(_benign_hit(rng, org, ts, seg))
    out.sort(key=lambda hit: hit["_source"]["@timestamp"])
    return out


# --------------------------------------------------------------------------- #
# MITRE ATT&CK storylines (named, seeded, multi-event)
# --------------------------------------------------------------------------- #
@dataclass
class Storyline:
    """A named ATT&CK storyline. ``generate`` returns the ECS hits for ONE ignition
    anchored at ``start_millis``. ``expected_verdict`` / ``expected_confidence``
    drive the deterministic mock LLM so the same storyline always yields the same
    verdict (NEEDS_HUMAN stories stay open for the HITL showcase). ``segment`` tags
    which demo source ingests it (``siem`` | ``xdr`` | ``edr``)."""

    id: str
    name: str
    techniques: list[str]
    expected_verdict: Verdict
    expected_confidence: float
    generate: Callable[[random.Random, Org, int], list[dict[str, Any]]]
    segment: str = "siem"


# Reserved RFC 5737 documentation infrastructure (LumenPay threat model).  Demo
# fixtures must never point an investigation or enrichment call at a real party.
_C2_IP = "203.0.113.77"          # simulated C2
_TOR_IP = "198.51.100.77"        # simulated anonymizer exit
_SQLI_IP = "192.0.2.90"          # simulated exploit scanner
_TRAVEL_IP_A = "203.0.113.190"   # in-country egress
_TRAVEL_IP_B = "198.51.100.190"  # simulated foreign ASN (impossible travel)
_C2_DOMAIN = "updates-win-sync.example"


def _phishing_chain(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    target = org.employees[0]  # pnair, loan-ops (flagship)
    portal = org.host_named("web-portal") or org.hosts[0]
    api = org.host_named("web-api") or org.hosts[0]
    hits: list[dict[str, Any]] = []
    hits.append(_hit(
        eid=f"demo-story-{start}-ph1", ts_millis=start, rule="demo_phishing_chain",
        rule_name="Phishing email with credential-harvest link", severity=72.0,
        ip=_C2_IP, user=target.user, host=portal.name, action="email", outcome="delivered",
        message=f"Phishing lure delivered to {target.user}",
    ))
    hits.append(_hit(
        eid=f"demo-story-{start}-ph2", ts_millis=start + 9 * 60_000, rule="demo_phishing_chain",
        rule_name="Suspicious borrower-portal sign-in after lure click", severity=78.0,
        ip=_C2_IP, user=target.user, host=portal.name, action="login", outcome="success",
        message=f"Credential-harvest sign-in for {target.user} from {_C2_IP}",
    ))
    hits.append(_hit(
        eid=f"demo-story-{start}-ph3", ts_millis=start + 22 * 60_000, rule="demo_phishing_chain",
        rule_name="OAuth token replay (credential access)", severity=80.0,
        ip=_C2_IP, user=target.user, host=api.name,
        action="token", outcome="success", message=f"Token replay against {api.name}",
    ))
    hits.append(_hit(
        eid=f"demo-story-{start}-ph4", ts_millis=start + 41 * 60_000, rule="demo_phishing_chain",
        rule_name="Lateral access to loan API", severity=82.0,
        ip=_C2_IP, user=target.user, host=api.name, action="access", outcome="success",
        message=f"Lateral access to {api.name} by {target.user}",
    ))
    hits.append(_hit(
        eid=f"demo-story-{start}-ph5", ts_millis=start + 63 * 60_000, rule="demo_phishing_chain",
        rule_name="Bulk borrower PII staged for exfiltration", severity=88.0,
        ip=_C2_IP, user=target.user, host=api.name, action="download", outcome="success",
        message=f"3.1 GB borrower PII staged + exfiltrated from {api.name} to {_C2_DOMAIN}",
        extra={"destination": {"domain": _C2_DOMAIN}},
    ))
    return hits


def _rdp_bruteforce(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    jump = org.host_named("jumpbox01") or org.hosts[0]
    hits: list[dict[str, Any]] = []
    for i in range(14):
        hits.append(_hit(
            eid=f"demo-story-{start}-rdp{i}", ts_millis=start + i * 4_000, rule="demo_rdp_bruteforce",
            rule_name="RDP brute-force attempt", severity=55.0 + i,
            ip=_SQLI_IP, user=f"admin{i % 3}", host=jump.name,
            action="login", outcome="failure",
            message=f"RDP failed login #{i + 1} on {jump.name} from {_SQLI_IP}",
        ))
    hits.append(_hit(
        eid=f"demo-story-{start}-rdpok", ts_millis=start + 60_000, rule="demo_rdp_bruteforce",
        rule_name="RDP brute-force succeeded", severity=84.0,
        ip=_SQLI_IP, user="admin0", host=jump.name, action="login", outcome="success",
        message=f"RDP login SUCCEEDED on {jump.name} after brute force",
    ))
    return hits


def _sqli_webshell(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    web = org.host_named("web-api") or org.hosts[0]
    hits = [
        _hit(eid=f"demo-story-{start}-sql{i}", ts_millis=start + i * 7_000, rule="demo_sqli_webshell",
             rule_name="SQL injection (OWASP CRS 942xxx)", severity=68.0 + i,
             ip=_SQLI_IP, host=web.name, action="request", outcome="blocked",
             message=f"SQLi probe #{i + 1} on {web.name}/v2/applications",
             extra={"rule": {"id": "942100", "name": "SQL injection (OWASP CRS 942xxx)"}})
        for i in range(8)
    ]
    hits.append(_hit(
        eid=f"demo-story-{start}-shell", ts_millis=start + 70_000, rule="demo_sqli_webshell",
        rule_name="Webshell uploaded via KYC document endpoint", severity=86.0,
        ip=_SQLI_IP, host=web.name, action="upload", outcome="success",
        message=f"Webshell dropped on {web.name}",
    ))
    return hits


def _impossible_travel(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    emp = org.employees[1]  # rmenon, DevOps
    vpn = org.host_named("vpn01") or org.hosts[0]
    return [
        _hit(eid=f"demo-story-{start}-it1", ts_millis=start, rule="demo_impossible_travel",
             rule_name="Sign-in from Mumbai", severity=40.0,
             ip=_TRAVEL_IP_A, user=emp.user, host=vpn.name, action="login", outcome="success",
             message=f"{emp.user} signed in from Mumbai, IN"),
        _hit(eid=f"demo-story-{start}-it2", ts_millis=start + 18 * 60_000, rule="demo_impossible_travel",
             rule_name="Impossible travel sign-in from foreign ASN", severity=74.0,
             ip=_TRAVEL_IP_B, user=emp.user, host=vpn.name, action="login", outcome="success",
             message=f"{emp.user} signed in from a foreign ASN 18m later (impossible travel)"),
    ]


def _ransomware_beacon(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    host = org.host_named("appsrv02") or org.hosts[0]
    hits = [
        _hit(eid=f"demo-story-{start}-beacon{i}", ts_millis=start + i * 30_000, rule="demo_ransomware_beacon",
             rule_name="C2 beacon (regular interval)", severity=70.0,
             ip=_TOR_IP, host=host.name, action="connect", outcome="success",
             message=f"Beacon #{i + 1} from {host.name} to {_TOR_IP}",
             extra={"destination": {"domain": _C2_DOMAIN}})
        for i in range(6)
    ]
    hits.append(_hit(
        eid=f"demo-story-{start}-encrypt", ts_millis=start + 240_000, rule="demo_ransomware_beacon",
        rule_name="Mass file modification (ransomware encryption)", severity=92.0,
        ip=_TOR_IP, host=host.name, action="modify", outcome="success",
        message=f"4,210 files modified on {host.name} (.locked extension)",
        extra={"file": {"hash": {"sha256": "a1b2c3d4e5f6" + "0" * 52}}},
    ))
    return hits


def _insider_staging(rng: random.Random, org: Org, start: int) -> list[dict[str, Any]]:
    emp = org.employees[5]  # akulkarni, Finance
    laptop = org.host_named("LP-LT-AKULK") or org.host_by_kind("workstation") or org.hosts[0]
    gw = org.host_named("bureau-gw") or org.hosts[0]
    return [
        _hit(eid=f"demo-story-{start}-ins1", ts_millis=start, rule="demo_insider_staging",
             rule_name="After-hours bulk borrower-record access", severity=48.0,
             ip=laptop.ip, user=emp.user, host=gw.name, action="access", outcome="success",
             message=f"{emp.user} accessed 900 borrower records on {gw.name} at 02:14"),
        _hit(eid=f"demo-story-{start}-ins2", ts_millis=start + 25 * 60_000, rule="demo_insider_staging",
             rule_name="Large outbound attachment to personal address", severity=58.0,
             ip=laptop.ip, user=emp.user, host=laptop.name, action="send", outcome="success",
             message=f"{emp.user} emailed a 240 MB archive to a personal address"),
    ]


STORYLINES: list[Storyline] = [
    Storyline("phishing_chain", "Phishing → ATO → lateral → PII exfil",
              ["T1566", "T1078", "T1021", "T1048"], Verdict.TRUE_POSITIVE, 0.93,
              _phishing_chain, segment="siem"),
    Storyline("sqli_webshell", "SQL injection → webshell (loan API)",
              ["T1190", "T1505.003"], Verdict.TRUE_POSITIVE, 0.90,
              _sqli_webshell, segment="siem"),
    Storyline("rdp_bruteforce", "RDP brute force (jump host)",
              ["T1110", "T1021.001"], Verdict.TRUE_POSITIVE, 0.88,
              _rdp_bruteforce, segment="xdr"),
    Storyline("ransomware_beacon", "Ransomware C2 beacon → encryption",
              ["T1071", "T1486"], Verdict.TRUE_POSITIVE, 0.95,
              _ransomware_beacon, segment="xdr"),
    Storyline("impossible_travel", "Impossible-travel sign-in",
              ["T1078", "T1556"], Verdict.NEEDS_HUMAN, 0.55,
              _impossible_travel, segment="edr"),
    Storyline("insider_staging", "Insider data staging",
              ["T1530", "T1048"], Verdict.NEEDS_HUMAN, 0.50,
              _insider_staging, segment="edr"),
]

_STORYLINE_BY_ID = {s.id: s for s in STORYLINES}


def storylines_for_segment(segment: str | None) -> list[Storyline]:
    """The storylines a given segment ignites (all storylines when segment is None)."""
    if not segment:
        return list(STORYLINES)
    return [s for s in STORYLINES if s.segment == segment]


# --------------------------------------------------------------------------- #
# Verdict resolution for the deterministic mock LLM (scenario-keyed)
# --------------------------------------------------------------------------- #
# Standards-faithful live-demo rule identities.  They live beside the provider's
# static lookup so import order can never change native storyline verdicts.
NATIVE_STORY_RULE_IDS: dict[str, dict[str, str]] = {
    "splunk": {
        "phishing_chain": "LP-ES-RISK-1001",
        "rdp_bruteforce": "LP-ES-RISK-1002",
        "sqli_webshell": "LP-ES-RISK-1003",
        "impossible_travel": "LP-ES-RISK-1004",
        "ransomware_beacon": "LP-ES-RISK-1005",
        "insider_staging": "LP-ES-RISK-1006",
    },
    "qradar": {
        "phishing_chain": "LP QRadar: account takeover and data access",
        "rdp_bruteforce": "LP QRadar: remote access brute force",
        "sqli_webshell": "LP QRadar: web exploit followed by web shell",
        "impossible_travel": "LP QRadar: impossible travel authentication",
        "ransomware_beacon": "LP QRadar: beaconing followed by encryption",
        "insider_staging": "LP QRadar: anomalous bulk data staging",
    },
    "wazuh": {
        # Wazuh reserves 100000-120000 for locally-authored rules. Keeping the
        # synthetic detections in that documented range avoids impersonating a
        # built-in Wazuh ruleset id.
        "phishing_chain": "100121",
        "rdp_bruteforce": "100122",
        "sqli_webshell": "100123",
        "impossible_travel": "100124",
        "ransomware_beacon": "100125",
        "insider_staging": "100126",
    },
    "syslog": {
        "phishing_chain": "AUTH-ANOMALY",
        "rdp_bruteforce": "RDP-BRUTEFORCE",
        "sqli_webshell": "WEB-EXPLOIT",
        "impossible_travel": "IMPOSSIBLE-TRAVEL",
        "ransomware_beacon": "RANSOMWARE-BURST",
        "insider_staging": "DATA-STAGING",
    },
    "entra": {
        "phishing_chain": "Entra ID Protection: credential phishing and account takeover",
        "rdp_bruteforce": "Entra ID Protection: password spray against privileged account",
        "sqli_webshell": "Entra ID Protection: workload identity anomaly after web exploit",
        "impossible_travel": "Entra ID Protection: atypical travel sign-in",
        "ransomware_beacon": "Entra ID Protection: risky service-principal sign-in",
        "insider_staging": "Entra ID Protection: anomalous bulk-access sign-in",
    },
}
NATIVE_RULE_TO_STORY: dict[str, str] = {
    native_rule: story_id
    for source_rules in NATIVE_STORY_RULE_IDS.values()
    for story_id, native_rule in source_rules.items()
}

# Each storyline stamps a DISTINCTIVE ``event.module`` UID (``demo_<story>``) on its
# events; that UID is reliably present in every prompt the pipeline builds (router /
# investigator carry the cluster's rule values), so the mock LLM resolves the story
# from the UID — no RNG, no clock. The descriptive rule names are kept as a fallback.
_RULE_TO_STORY: dict[str, str] = {f"demo_{s.id}": s.id for s in STORYLINES}
_RULE_TO_STORY.update(NATIVE_RULE_TO_STORY)
_STORY_RULE_NAMES: dict[str, tuple[str, ...]] = {
    "phishing_chain": (
        "Phishing email with credential-harvest link",
        "Suspicious borrower-portal sign-in after lure click",
        "OAuth token replay (credential access)",
        "Lateral access to loan API",
        "Bulk borrower PII staged for exfiltration",
    ),
    "rdp_bruteforce": ("RDP brute-force attempt", "RDP brute-force succeeded"),
    "sqli_webshell": ("SQL injection (OWASP CRS 942xxx)",
                      "Webshell uploaded via KYC document endpoint"),
    "impossible_travel": ("Sign-in from Mumbai", "Impossible travel sign-in from foreign ASN"),
    "ransomware_beacon": ("C2 beacon (regular interval)",
                          "Mass file modification (ransomware encryption)"),
    "insider_staging": ("After-hours bulk borrower-record access",
                        "Large outbound attachment to personal address"),
}
for _sid, _names in _STORY_RULE_NAMES.items():
    for _n in _names:
        _RULE_TO_STORY[_n] = _sid


def resolve_story_verdict(rule_values: list[str]) -> tuple[Verdict, float, list[str], str] | None:
    """Map a set of (synthetic) rule UIDs / names to a storyline's stable verdict.

    Returns ``(verdict, confidence, techniques, story_id)`` when the events belong
    to a known storyline, else None (the caller defaults to FALSE_POSITIVE for the
    benign baseline). Deterministic — no RNG, no clock. Used by the deterministic
    mock provider to key a cluster's verdict to its scenario."""
    for name in rule_values:
        sid = _RULE_TO_STORY.get(name)
        if sid:
            s = _STORYLINE_BY_ID[sid]
            return s.expected_verdict, s.expected_confidence, list(s.techniques), s.id
    return None


# --------------------------------------------------------------------------- #
# Public generator surface used by the connector + simulator
# --------------------------------------------------------------------------- #
def generate_window_hits(
    rng: random.Random, org: Org, *, from_millis: int, to_millis: int,
    benign_per_hour: int = 6, segment: str | None = None,
) -> list[dict[str, Any]]:
    """All benign ECS hits in ``[from_millis, to_millis)`` for the cursor window.

    The per-hour count is the diurnal envelope scaled by ``benign_per_hour``. When
    ``segment`` is given only that segment's rule/host pool is drawn (else the full
    union). Deterministic for a given rng + args."""
    out: list[dict[str, Any]] = []
    if to_millis <= from_millis:
        return out
    h = (from_millis // _MS_PER_HOUR) * _MS_PER_HOUR
    while h < to_millis:
        n = max(0, round(benign_per_hour * diurnal_weight(h)))
        for hit in generate_benign_batch(rng, org, h, n, segment):
            ts = hit["_source"]
            tsm = _parse_ts(ts["@timestamp"])
            if from_millis <= tsm < to_millis:
                out.append(hit)
        h += _MS_PER_HOUR
    out.sort(key=lambda hit: hit["_source"]["@timestamp"])
    return out


def _parse_ts(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


def hits_to_ocsf(hits: list[dict[str, Any]], prefs: Preferences) -> list[OCSFEvent]:
    """Map ECS hits to OCSF events (the connector-agnostic projection)."""
    from ..constants import SourceType

    return [
        ecs_to_ocsf(h, prefs, source_type=SourceType.GENERIC, connector_id=DEMO_SOURCE_ID)
        for h in hits
    ]


def hits_to_raw(
    hits: list[dict[str, Any]], prefs: Preferences, *,
    source_id: str = DEMO_SOURCE_ID, source_name: str = DEMO_SOURCE_NAME,
) -> list[RawEvent]:
    """Map ECS hits to RawEvents tagged with the demo source (connector path). The
    ``source_id``/``source_name`` default to the legacy single-source id so existing
    callers are byte-identical; the 3-segment connectors pass their own id."""
    out: list[RawEvent] = []
    for h in hits:
        ev = RawEvent.from_hit(h, prefs)
        ev.source_id = source_id
        ev.source_name = source_name
        out.append(ev)
    return out


# --------------------------------------------------------------------------- #
# Historical case spread (backdated finished cases for "old data" surfaces)
# --------------------------------------------------------------------------- #
# Each template names the detection its case carries (``signal``): a storyline's own
# detection (``story``), a source's low-confidence native alert (``alert``), or an
# anomaly flagged in a source's routine telemetry (``telemetry``). The case's rule is
# the one its Demo source raises for that detection (``demo_sources.
# seeded_detection_rule``), so the rule sheet, Logs and the runbook lookups find the
# case's own rows (``seed_demo_case_evidence``). A storyline case rotates over every
# source, as the storyline itself does; the others stay on the sources (``sources``)
# that raise a fitting signal and take them in turn (``seeded_case_detection``). A
# person's case on Entra ID names the person by the user principal name Entra's
# sign-in records carry (``demo_sources.source_user_name``), as a live Entra case does.
_HIST_TEMPLATES: tuple[dict[str, Any], ...] = (
    {"signal": "story", "story": "rdp_bruteforce", "rname": "RDP brute-force attempt", "et": EntityType.IP,
     "verdict": Verdict.TRUE_POSITIVE, "disp": Disposition.TRUE_POSITIVE,
     "status": CaseStatus.RESOLVED, "risk": 78.0, "mitre": ["T1110"],
     "tags": ["brute-force", "rdp"]},
    {"signal": "story", "story": "sqli_webshell", "rname": "SQL injection (OWASP CRS 942xxx)",
     "et": EntityType.IP, "verdict": Verdict.TRUE_POSITIVE, "disp": Disposition.TRUE_POSITIVE,
     "status": CaseStatus.CLOSED, "risk": 82.0, "mitre": ["T1190"], "tags": ["web", "sqli"]},
    {"signal": "telemetry", "sources": ("wazuh",), "rname": "Endpoint telemetry anomaly", "et": EntityType.HOST,
     "verdict": Verdict.FALSE_POSITIVE, "disp": Disposition.FALSE_POSITIVE,
     "status": CaseStatus.CLOSED, "risk": 18.0, "mitre": [], "tags": ["noise"]},
    {"signal": "alert", "sources": ("splunk", "qradar", "wazuh"), "rname": "Scanner activity", "et": EntityType.IP,
     "verdict": Verdict.FALSE_POSITIVE, "disp": Disposition.BENIGN,
     "status": CaseStatus.CLOSED, "risk": 22.0, "mitre": ["T1595"], "tags": ["scanner"]},
    {"signal": "story", "story": "impossible_travel", "rname": "Suspicious mailbox sign-in", "et": EntityType.USER,
     "verdict": Verdict.NEEDS_HUMAN, "disp": Disposition.SUSPICIOUS,
     "status": CaseStatus.ESCALATED, "risk": 64.0, "mitre": ["T1078"], "tags": ["identity"]},
    {"signal": "story", "story": "insider_staging", "rname": "Outbound data anomaly", "et": EntityType.USER,
     "verdict": Verdict.NEEDS_HUMAN, "disp": Disposition.UNDETERMINED,
     "status": CaseStatus.ON_HOLD, "risk": 55.0, "mitre": ["T1048"], "tags": ["exfil"]},
    {"signal": "story", "story": "sqli_webshell", "rname": "WAF blocked exploit", "et": EntityType.IP,
     "verdict": Verdict.TRUE_POSITIVE, "disp": Disposition.TRUE_POSITIVE,
     "status": CaseStatus.RESOLVED, "risk": 71.0, "mitre": ["T1190"], "tags": ["waf"]},
    {"signal": "telemetry", "sources": ("splunk", "entra"), "rname": "Borrower-portal anomaly",
     "et": EntityType.USER, "verdict": Verdict.FALSE_POSITIVE, "disp": Disposition.DUPLICATE,
     "status": CaseStatus.CLOSED, "risk": 12.0, "mitre": [], "tags": ["duplicate"]},
)

_ANALYSTS = ("pnair", "sgupta", "dsingh", "auto-triage")
_BAD_IP_PREFIXES = ("203.0.113", "198.51.100", "192.0.2")


def _demo_risk_breakdown(total: float) -> RiskBreakdown:
    """Return varied demo factors that reconcile to ``total`` under defaults.

    Demo cases pre-date a persisted risk-weight snapshot.  Keeping their five
    factor values internally coherent with the default ``RiskWeights`` makes the
    Timeline's read-only risk explanation useful instead of presenting invented,
    non-reconciling arithmetic.  If an operator later changes those weights, the
    API still reports the difference honestly rather than rewriting history.
    """
    risk = max(0.0, min(100.0, float(total)))
    spread = min(risk, 100.0 - risk, 15.0) / 15.0
    volume = round(risk + 10.0 * spread, 2)
    velocity = round(risk - 5.0 * spread, 2)
    reputation = round(risk + 5.0 * spread, 2)
    diversity = round(risk - 10.0 * spread, 2)
    # Solve the final factor after rounding the others so the persisted demo
    # values reproduce the displayed score with the default 25/20/30/15/10 mix.
    asset = round(
        (risk - 0.25 * volume - 0.20 * velocity - 0.30 * reputation - 0.15 * diversity)
        / 0.10,
        2,
    )
    return RiskBreakdown(
        volume=volume,
        velocity=velocity,
        reputation=reputation,
        diversity=diversity,
        asset_criticality=max(0.0, min(100.0, asset)),
        total=round(risk, 2),
    )


#: A verdict as the console words it in a seeded summary or status reason ("Outbound data
#: anomaly (needs human review).", never the raw enum "(NEEDS_HUMAN)").
_VERDICT_TEXT: dict[Verdict, str] = {
    Verdict.TRUE_POSITIVE: "true positive",
    Verdict.FALSE_POSITIVE: "false positive",
    Verdict.NEEDS_HUMAN: "needs human review",
}


def seeded_case_detection(tmpl: dict[str, Any], idx: int, *, ordinal: int) -> tuple[str, str, str]:
    """``(source key, source id, rule)`` of a seeded case built from ``tmpl``.

    A storyline case rotates over every Demo source by its place in the spread
    (``idx``), as the storyline does. Any other takes its template's ``sources`` in
    turn by its own ordinal (``ordinal``: the how-many-th case of this template), so
    every listed source is reached whatever the template's position in the cycle (a
    rotation on ``idx`` would pin a template whose position shares a factor with the
    length of its ``sources`` to some of them forever). The rule is what that source
    raises for the template's signal (``demo_sources.seeded_detection_rule``), never a
    Demo-only name. Pure and deterministic."""
    from .demo_sources import DEMO_SOURCE_SPECS, seeded_detection_rule

    keys = tuple(tmpl.get("sources") or ())
    if keys:
        key = keys[ordinal % len(keys)]
        source_id = DEMO_SOURCE_SPECS[key].source_id
    else:
        source_id = DEMO_SOURCE_IDS[idx % len(DEMO_SOURCE_IDS)]
        key = next(k for k, spec in DEMO_SOURCE_SPECS.items() if spec.source_id == source_id)
    rule, _name = seeded_detection_rule(str(tmpl["signal"]), key, tmpl.get("story"))
    return key, source_id, rule


def _hist_case(
    rng: random.Random, org: Org, tmpl: dict[str, Any], *, cid: str, sig_suffix: str,
    created_ms: int, first_seen_ms: int, idx: int, ordinal: int,
    status: CaseStatus | None = None,
) -> Case:
    """Build ONE finished/near-finished demo Case from a template (shared by the
    historical spread and the recent pre-seed). ``status`` overrides the template's.
    The case's rule is the one its Demo source raises (:func:`seeded_case_detection`;
    ``ordinal`` is the how-many-th case of this template), and a person is named as
    that source's records name them (``demo_sources.source_user_name``)."""
    from .demo_sources import source_user_name

    source_key, source_id, rule = seeded_case_detection(tmpl, idx, ordinal=ordinal)
    created = _iso(created_ms)
    et: EntityType = tmpl["et"]
    if et == EntityType.IP:
        entity_val = f"{rng.choice(_BAD_IP_PREFIXES)}.{rng.randint(2, 250)}"
    elif et == EntityType.USER:
        entity_val = source_user_name(source_key, rng.choice(org.employees).user)
    else:
        entity_val = rng.choice([h.name for h in org.hosts])
    sig = f"demo-sig-{et.value}-{entity_val}-{sig_suffix}"
    st: CaseStatus = status if status is not None else tmpl["status"]
    verdict: Verdict = tmpl["verdict"]
    risk = float(tmpl["risk"])
    decision_by = (
        DecisionBy.AGENT if st in (CaseStatus.CLOSED,) and verdict == Verdict.FALSE_POSITIVE
        else DecisionBy.ANALYST if st in (CaseStatus.RESOLVED, CaseStatus.CLOSED)
        else DecisionBy.SYSTEM
    )
    analyst = rng.choice(_ANALYSTS)
    comments: list[CaseComment] = []
    if idx % 3 == 0:
        comments.append(CaseComment(
            ts=created, author=analyst,
            body=f"Triaged {tmpl['rname']}; {('escalating' if st == CaseStatus.ESCALATED else 'tracking')}.",
        ))
    notifications_sent: list[dict[str, Any]] = []
    if verdict == Verdict.TRUE_POSITIVE and idx % 2 == 0:
        notifications_sent.append({
            "ts": created, "trigger": "on_true_positive", "channel_id": "demo-email",
            "channel_type": "email", "ok": True, "detail": "delivered (simulated)",
        })
    automation_actions: list[dict[str, Any]] = []
    if idx % 4 == 0:
        automation_actions.append({
            "ts": created, "rule_id": "demo-auto-1", "action": "tag",
            "detail": "auto-tagged 'reviewed' (simulated)",
        })
    knowledge_used: list[dict[str, Any]] = []
    if tmpl["mitre"]:
        knowledge_used.append({
            "source": "mitre", "snippet": f"Technique {tmpl['mitre'][0]} reference.", "score": 0.81,
        })
    status_history = [StatusHistoryEntry(
        from_status="new", to_status=st.value, by=decision_by.value,
        at=created, reason=f"demo: {tmpl['rname']}, {_VERDICT_TEXT[verdict]}",
    )]
    return Case(
        case_id=cid,
        cluster_signature=sig,
        **current_record_provenance(),
        created_at=created,
        updated_at=created,
        source_surface=SourceSurface.AUTOMATED_SCAN if idx % 2 == 0 else SourceSurface.INVESTIGATE,
        origin_surface=SourceSurface.AUTOMATED_SCAN if idx % 2 == 0 else SourceSurface.INVESTIGATE,
        rule_ids=[rule],
        entity=Entity(type=et, value=entity_val),
        source_id=source_id,
        source_name=DEMO_SOURCE_NAMES[source_id],
        # Unique across the whole seed (the historical spread and the recent pre-seed
        # number their cases from 0 alike): each id is also the id of the case's own row
        # its Demo source keeps (``demo_sources.NativeDemoSource.record_case_history``).
        member_event_ids=[f"demo-hist-{sig_suffix}-{j}" for j in range(rng.randint(2, 9))],
        first_seen_millis=first_seen_ms,
        risk_score=risk,
        risk_breakdown=_demo_risk_breakdown(risk),
        verdict=verdict,
        confidence=round(0.5 + rng.random() * 0.49, 2),
        evidence=[EvidenceItem(summary=f"{tmpl['rname']} on {entity_val}.", event_ids=[])],
        mitre=list(tmpl["mitre"]),
        recommended_action=("Escalate." if st == CaseStatus.ESCALATED
                            else "No action required." if verdict == Verdict.FALSE_POSITIVE
                            else "Contain and monitor."),
        reproduce_query=f'{et.value} : "{entity_val}"',
        status=st,
        disposition=tmpl["disp"],
        escalation_level=1 if st == CaseStatus.ESCALATED else 0,
        status_history=status_history,
        decision_by=decision_by,
        agent_persona=rng.choice(["identity", "web", "malware", "recon", "threat_intel", ""]),
        tags=list(tmpl["tags"]),
        comments=comments,
        assignee=analyst if st in (CaseStatus.ESCALATED, CaseStatus.ON_HOLD) else "",
        title=f"{et.value}:{entity_val} · {rule}",
        summary=f"{tmpl['rname']} ({_VERDICT_TEXT[verdict]}).",
        token_cost=round(rng.random() * 0.04, 6),
        notifications_sent=notifications_sent,
        automation_actions=automation_actions,
        knowledge_used=knowledge_used,
        retrieval_history_status="available",
        retrieval_observation_status="measured",
    )


def generate_historical_cases(
    seed: int, org: Org, *, history_days: int, run_id: str, now_millis: int,
) -> list[Case]:
    """A believable, BACKDATED spread of finished cases over ``history_days``.

    Every status / disposition / severity / source appears at least once, with a
    couple of NEEDS_HUMAN/ESCALATED/ON_HOLD cases LEFT OPEN for the HITL showcase,
    and a few carrying comments / notifications_sent / automation_actions /
    knowledge_used so every feature surface has data. Deterministic for a given
    seed; every case is tagged ``demo`` + ``case_id='demo-...'`` and carries the
    ``run_id`` (in a tag) so disable can purge by run_id."""
    del run_id  # run identity is carried by _DemoCaseStore's run tag, not fixture facts
    rng = random.Random(seed ^ 0x5EED)
    seed_tag = f"{seed & 0xFFFFFFFF:08x}"
    cases: list[Case] = []
    # Roughly 3-4 cases/day, spread across the trailing window. Cap so the demo is
    # snappy but every surface is populated.
    per_day = 3
    total = max(len(_HIST_TEMPLATES) + 4, per_day * max(1, history_days))
    total = min(total, 60)
    for i in range(total):
        tmpl = _HIST_TEMPLATES[i % len(_HIST_TEMPLATES)]
        # Backdate uniformly across the window (older first), with intra-day jitter.
        day_offset = (i * max(1, history_days)) // max(1, total)
        created_ms = now_millis - day_offset * _MS_PER_DAY - rng.randint(0, _MS_PER_DAY - 1)
        # Realistic detection latency: the first cluster event fired 0.75-30 min before
        # the case was opened, so the demo shows a believable MTTD (advisory only, #3).
        first_seen_ms = created_ms - rng.randint(45, 1800) * 1000
        cid = f"demo-{seed_tag}-{i:04d}"
        cases.append(_hist_case(
            rng, org, tmpl, cid=cid, sig_suffix=str(i),
            created_ms=created_ms, first_seen_ms=first_seen_ms, idx=i, ordinal=i // len(_HIST_TEMPLATES),
        ))
    return cases


# --------------------------------------------------------------------------- #
# Recent pre-seed — a tight "just happened" window (recent cases + processed events)
# --------------------------------------------------------------------------- #
# A curated trio of "just arrived" cases: one TRUE_POSITIVE-escalate, one NEEDS_HUMAN,
# one FALSE_POSITIVE — with realistic still-open statuses (not all terminal) so the
# console visibly has fresh work sitting on top of the auto-closed noise.
_PRESEED_TEMPLATES: tuple[tuple[dict[str, Any], CaseStatus], ...] = (
    ({"signal": "story", "story": "phishing_chain", "rname": "Phishing → ATO on borrower portal",
      "et": EntityType.USER, "verdict": Verdict.TRUE_POSITIVE, "disp": Disposition.TRUE_POSITIVE,
      "status": CaseStatus.ESCALATED, "risk": 88.0, "mitre": ["T1566", "T1078"],
      "tags": ["ato", "phishing", "escalate"]}, CaseStatus.ESCALATED),
    ({"signal": "story", "story": "impossible_travel", "rname": "Impossible-travel admin sign-in",
      "et": EntityType.USER, "verdict": Verdict.NEEDS_HUMAN, "disp": Disposition.SUSPICIOUS,
      "status": CaseStatus.INVESTIGATING, "risk": 62.0, "mitre": ["T1078"],
      "tags": ["identity", "needs-human"]}, CaseStatus.INVESTIGATING),
    ({"signal": "alert", "sources": ("splunk", "qradar"), "rname": "KYC-form XSS probe (blocked)",
      "et": EntityType.IP, "verdict": Verdict.FALSE_POSITIVE, "disp": Disposition.BENIGN,
      "status": CaseStatus.NEW, "risk": 20.0, "mitre": [],
      "tags": ["waf", "benign"]}, CaseStatus.NEW),
)


def generate_recent_preseed(
    seed: int, org: Org, *, run_id: str, now_millis: int,
    recent_minutes: int = 10, case_count: int = 3, event_count: int = 100,
) -> tuple[list[Case], list[dict[str, Any]]]:
    """A tight, backdated "just happened" window: ``case_count`` cases whose
    ``created_at``/``first_seen_millis`` land in the last ``recent_minutes`` (the
    freshest few minutes of the console, distinct from the broader ``history_days``
    spread — case ids are prefixed ``demo-recent-`` so "just arrived" is
    distinguishable from backdated history), plus ``event_count`` benign ECS hits
    already generated for that same window (for the noise-reduction/metrics surfaces
    to show 'already processed' volume). Deterministic for a given seed+run_id.

    The trio is varied on purpose (TP-escalate + NEEDS_HUMAN + FP) with realistic
    still-open statuses so at least one case is non-terminal ("just arrived")."""
    del run_id
    rng = random.Random(seed ^ 0x2ECE47)
    seed_tag = f"{seed & 0xFFFFFFFF:08x}"
    window_ms = max(1, recent_minutes) * 60_000
    cases: list[Case] = []
    for i in range(max(0, case_count)):
        tmpl, status = _PRESEED_TEMPLATES[i % len(_PRESEED_TEMPLATES)]
        # A tight recency spread: freshest first (a couple of minutes old), never older
        # than the window.
        created_ms = now_millis - rng.randint(30_000, window_ms - 1)
        first_seen_ms = created_ms - rng.randint(30, 300) * 1000
        cid = f"demo-recent-{seed_tag}-{i:04d}"
        cases.append(_hist_case(
            rng, org, tmpl, cid=cid, sig_suffix=f"recent-{i}",
            created_ms=created_ms, first_seen_ms=first_seen_ms, idx=i,
            ordinal=i // len(_PRESEED_TEMPLATES), status=status,
        ))
    hits = generate_recent_events(
        rng, org, from_millis=now_millis - window_ms, to_millis=now_millis,
        count=event_count,
    )
    return cases, hits


# --------------------------------------------------------------------------- #
# Capability seed — deterministic cases that make the HITL / campaign / adaptive-
# tuning capabilities show REAL signal the instant demo is enabled.
# --------------------------------------------------------------------------- #
# Why this is needed: the seeded HITL approval rule only fires on verdict=NEEDS_HUMAN,
# but the live SIEM stories are BOTH TRUE_POSITIVE, the NEEDS_HUMAN stories only ignite
# benign EDR/XDR events, and the pre-seed cases are saved directly (bypassing
# automation) — so on a fresh enable proposals_open / campaigns_found / tuning_events
# all stay 0 and only RAG shows signal. These deterministic, demo-scoped seed cases fix
# that (all writes land in the demo stores; the real ledgers stay untouched).
#
# A UNIQUE detection-rule id present ONLY on the seeded noisy false-positives, so the
# adaptive tuner attributes a clean per-rule FP signal to it AND (crucially) shadow-eval
# finds NO confirmed TRUE_POSITIVE sharing it → the bounded correlation-n bump auto-
# applies deterministically.
DEMO_TUNER_RULE = "demo_noisy_scanner"


def generate_capability_seed_cases(
    seed: int, org: Org, *, run_id: str, now_millis: int, tuner_fp_count: int = 30,
) -> tuple[list[Case], list[Case]]:
    """Deterministic, demo-scoped seed cases so the HITL / campaign / adaptive-tuning
    capabilities show live signal the instant demo is enabled.

    Returns ``(hitl_cases, tuner_cases)``:

    * ``hitl_cases`` — a PAIR of NEEDS_HUMAN cases that BOTH bind entity
      ``(user, 'pnair')`` at the SAME instant (so they can never straddle a day-bucket
      boundary → the pair is always in one campaign bucket). Firing threshold-automation
      on each opens a demo HITL Proposal (verdict=NEEDS_HUMAN → request_approval); the
      shared entity also folds the pair into >= 1 Campaign in the synchronous capability
      pass. Each carries the impossible-travel rule its own Demo source raises
      (``demo_sources.seeded_detection_rule``), so its rule sheet, Logs and runbook
      lookups read the rows ``seed_demo_case_evidence`` keeps for it.
    * ``tuner_cases`` — ``tuner_fp_count`` CLOSED / FALSE_POSITIVE cases all keyed on the
      SAME unique rule (:data:`DEMO_TUNER_RULE`), each with a DISTINCT benign entity and
      NO MITRE (so they never themselves form a campaign). Comfortably above the tuner's
      default ``min_samples`` (25) with a Wilson-LB FP-rate well over target, so exactly
      ONE bounded correlation-n observation is recorded.

    Every case is demo-tagged with a ``demo-…`` case_id (write-guard clean) and dated
    ~now (inside the campaign's daily window AND the tuner's trailing window). The id
    stem is derived from ``seed`` so resets and separate Python processes reproduce
    identical facts; ``run_id`` remains only an isolation tag on the throwaway store."""
    from .demo_sources import source_user_name

    del run_id
    rng = random.Random(seed ^ 0xCAB1E)
    tag8 = f"{seed & 0xFFFFFFFF:08x}"

    # --- HITL / campaign pair: two NEEDS_HUMAN cases on the SAME entity + instant.
    hitl_ms = now_millis - 120_000
    hitl_iso = _iso(hitl_ms)
    hitl_cases: list[Case] = []
    for i in range(2):
        source_key, source_id, hitl_rule = seeded_case_detection(
            {"signal": "story", "story": "impossible_travel"}, i, ordinal=i)
        hitl_cases.append(Case(
            case_id=f"demo-hitl-{tag8}-{i:04d}",
            cluster_signature=f"demo-cap-hitl-{i}",
            **current_record_provenance(),
            created_at=hitl_iso, updated_at=hitl_iso,
            source_surface=SourceSurface.AUTOMATED_SCAN,
            origin_surface=SourceSurface.AUTOMATED_SCAN,
            rule_ids=[hitl_rule],
            entity=Entity(type=EntityType.USER, value=source_user_name(source_key, "pnair")),
            source_id=source_id,
            source_name=DEMO_SOURCE_NAMES[source_id],
            member_event_ids=[f"demo-hitl-{i}-{j}" for j in range(3)],
            first_seen_millis=hitl_ms - 60_000,
            risk_score=62.0,
            risk_breakdown=_demo_risk_breakdown(62.0),
            verdict=Verdict.NEEDS_HUMAN, confidence=0.55,
            evidence=[EvidenceItem(summary="Impossible-travel sign-in for pnair.", event_ids=[])],
            mitre=["T1078"],
            recommended_action="Confirm with the user; approve/reject to see the HITL path.",
            status=CaseStatus.INVESTIGATING, disposition=Disposition.SUSPICIOUS,
            decision_by=DecisionBy.SYSTEM,
            status_history=[StatusHistoryEntry(
                from_status="new", to_status=CaseStatus.INVESTIGATING.value,
                by=DecisionBy.SYSTEM.value, at=hitl_iso,
                reason=f"demo: impossible travel, {_VERDICT_TEXT[Verdict.NEEDS_HUMAN]}",
            )],
            severity_band="high",
            tags=["demo", "needs-human", "identity"],
            title=f"user:{source_user_name(source_key, 'pnair')} · {hitl_rule}",
            summary=f"Impossible-travel sign-in ({_VERDICT_TEXT[Verdict.NEEDS_HUMAN]}).",
            retrieval_history_status="available",
            retrieval_observation_status="not_measured",
        ))

    # --- Tuner noise: N same-rule CLOSED false-positives, DISTINCT benign entities.
    tuner_iso = _iso(now_millis - 60_000)
    tuner_cases: list[Case] = []
    for i in range(max(0, tuner_fp_count)):
        confidence = round(0.6 + rng.random() * 0.3, 2)
        tuner_cases.append(Case(
            case_id=f"demo-tune-{tag8}-{i:04d}",
            cluster_signature=f"demo-cap-tune-{i}",
            **current_record_provenance(),
            created_at=tuner_iso, updated_at=tuner_iso,
            source_surface=SourceSurface.AUTOMATED_SCAN,
            origin_surface=SourceSurface.AUTOMATED_SCAN,
            rule_ids=[DEMO_TUNER_RULE],
            entity=Entity(type=EntityType.IP, value=f"10.66.{i // 250}.{i % 250}"),
            source_id=DEMO_SOURCE_IDS[i % len(DEMO_SOURCE_IDS)],
            source_name=DEMO_SOURCE_NAMES[DEMO_SOURCE_IDS[i % len(DEMO_SOURCE_IDS)]],
            member_event_ids=[f"demo-tune-{i}-0"],
            risk_score=16.0,
            risk_breakdown=_demo_risk_breakdown(16.0),
            verdict=Verdict.FALSE_POSITIVE, confidence=confidence,
            evidence=[EvidenceItem(summary="Benign scanner noise (auto-closed).", event_ids=[])],
            recommended_action="No action required.",
            status=CaseStatus.CLOSED, disposition=Disposition.FALSE_POSITIVE,
            decision_by=DecisionBy.AGENT,
            status_history=[StatusHistoryEntry(
                from_status="new", to_status=CaseStatus.CLOSED.value,
                by=DecisionBy.AGENT.value, at=tuner_iso,
                reason=f"demo: noisy scanner, {_VERDICT_TEXT[Verdict.FALSE_POSITIVE]}",
            )],
            # Explicit synthetic analyst evidence keeps the demo honest under the
            # production tuner's independent-outcome requirement.  The model verdict
            # alone is never used to train a threshold change.
            feedback=[FeedbackEntry(
                ts=tuner_iso,
                analyst="demo.analyst",
                assessment="agree",
                accuracy=1.0,
                reasoning_quality=1.0,
                action_appropriateness=1.0,
                actual_outcome="false_positive",
                comment="Synthetic analyst-confirmed demo outcome.",
                ai_verdict=Verdict.FALSE_POSITIVE.value,
                ai_confidence=confidence,
            )],
            severity_band="low",
            tags=["demo", "noise"],
            title=f"ip · {DEMO_TUNER_RULE} #{i + 1}",
            summary=f"Benign scanner noise ({_VERDICT_TEXT[Verdict.FALSE_POSITIVE]}).",
            retrieval_history_status="available",
            retrieval_observation_status="not_measured",
        ))
    return hitl_cases, tuner_cases


# --------------------------------------------------------------------------- #
# Runbook runs for the seeded cases (Round 14 SPEC §4.10.18, D45)
# --------------------------------------------------------------------------- #
# The seeded cases are saved directly (they never pass through the pipeline that
# attaches a runbook), so Demo Mode would open with an empty Runbook tab and empty
# library metrics. This seed attaches the matching runbook to every seeded case a
# person works (an open case that needs a person, and a case an analyst closed),
# exactly as the matcher would (same catalog, same tier rule, the Demo overlay), and
# works a deterministic part of each run: an analyst-closed case's run is complete,
# with believable step times; an open case's run is part way through. Pure planning
# (:func:`plan_demo_runbook_runs`) plus one bounded writer; every write lands in the
# Demo run store and vanishes with Demo Mode. Never a model call, and the plan never
# reads a log: once Demo Mode is active, the seeded runs' lookups are run by the live
# engine against the Demo stores (:func:`collect_demo_runbook_lookups`), so what a
# seeded step shows is what "Run lookup" returns for it, never a made-up figure.

#: At most this many seeded runs (the newest human-facing cases first).
DEMO_RUNBOOK_RUNS_MAX = 80
_DEMO_RUN_NAMESPACE = "agentic-soc-demo-runbook-run"
_DEMO_STEP_NOTES: dict[str, str] = {
    "check": "Checked during the demo shift.",
    "lookup": "Reviewed the lookup results.",
    "decision": "Decided from the evidence on the case.",
    "action": "Recorded for the demo.",
    "record": "Recorded for the demo.",
}


def _demo_moment(value: Any, fallback_ms: int) -> datetime:
    """A case timestamp as an aware datetime (``fallback_ms`` when it cannot be read)."""
    if isinstance(value, str) and value.strip():
        try:
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.fromtimestamp(fallback_ms / 1000, tz=timezone.utc)


def _demo_iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _demo_decision_option(step: Any, verdict: Any) -> Any:
    """The option a seeded decision takes: the first (the hostile reading) for a true
    positive, the last (the benign one) for a false positive, the middle otherwise."""
    options = list(getattr(step, "options", []) or [])
    if not options:
        return None
    value = getattr(verdict, "value", verdict)
    if value == Verdict.TRUE_POSITIVE.value:
        return options[0]
    if value == Verdict.FALSE_POSITIVE.value:
        return options[-1]
    return options[len(options) // 2]


def demo_runbook_run_id(seed: int, case_id: str, runbook_id: str) -> str:
    """The id of the run the seed attaches to ``case_id`` (deterministic for a seed),
    which also tells a seeded run from one a person started later."""
    import uuid

    return "run-" + uuid.uuid5(uuid.NAMESPACE_URL, f"{_DEMO_RUN_NAMESPACE}:{seed}:{case_id}:{runbook_id}").hex


def plan_demo_runbook_runs(
    cases: list[Case], catalog: Any, *, prefs: Preferences, seed: int, now_millis: int,
    limit: int = DEMO_RUNBOOK_RUNS_MAX,
) -> list[Any]:
    """The runs to seed for ``cases`` (``engine.runbook_runs`` models; pure and
    deterministic for a seed). ``catalog`` is the Demo pipeline's matchable catalog (an
    iterable of ``MatchableRunbook`` or an object with ``matchable``). A case gets the
    runbook :func:`runbook_runs.plan_attachment` picks, when it is open and needs a
    person or an analyst closed it; an automatic close never gets one (§4.10.4).

    The operator's switches apply as they do to a live attachment
    (``runbook_runs.reevaluate_case``): nothing is seeded while runbooks or automatic
    attachment are off, and Generic incident is attached only while the fallback is
    on.

    No lookup step carries a result here: the planner is pure and never reads a log
    source, the case store or the member events a lookup binds from, so any figure
    it wrote would be made up. The lookups are run by the live engine against the
    Demo stores once Demo Mode is active (:func:`collect_demo_runbook_lookups`, at
    the moments :func:`demo_lookup_schedule` gives)."""
    from types import SimpleNamespace

    from ..models import RunbookRun, StepState
    from .runbook_runs import (
        _FINISHED_STEP, attachment_blocked, case_facts, ordered_steps, plan_attachment,
    )

    cfg = getattr(prefs, "runbooks", None)
    if cfg is None or not (cfg.enabled and cfg.auto_attach):
        return []
    fallback = bool(cfg.fallback)
    matchable = tuple(getattr(catalog, "matchable", catalog) or ())
    view = SimpleNamespace(matchable=matchable)
    now = datetime.fromtimestamp(now_millis / 1000, tz=timezone.utc)
    analyst_closed = {CaseStatus.RESOLVED.value, CaseStatus.CLOSED.value}
    picked: list[tuple[Case, bool]] = []
    for case in sorted(cases, key=lambda c: str(c.created_at or ""), reverse=True):
        status = getattr(case.status, "value", case.status)
        closed_by_person = (status in analyst_closed
                            and getattr(case.decision_by, "value", case.decision_by) == DecisionBy.ANALYST.value)
        if attachment_blocked(case, now=now) is None or closed_by_person:
            picked.append((case, closed_by_person))
        if len(picked) >= limit:
            break
    runs: list[Any] = []
    for case, closed_by_person in picked:
        plan = plan_attachment(case_facts(case, prefs), view, (), fallback=fallback)
        if plan is None:
            continue
        entry = plan.entry
        rng = random.Random(f"{seed}:{case.case_id}:{entry.id}")
        created = _demo_moment(case.created_at, now_millis)
        # The work happens between the attachment and the close (an analyst-closed
        # case) or now (an open one), never in the future.
        end = min(_demo_moment(case.updated_at, now_millis), now) if closed_by_person else now
        attached = min(created + timedelta(minutes=rng.randint(1, 4)), end)
        # A runbook is worked by a person: the case's analyst, or one of the Demo
        # analysts when the case belongs to the triage automation or to nobody.
        people = tuple(a for a in _ANALYSTS if a != "auto-triage")
        person = case.assignee if case.assignee in people else people[rng.randrange(len(people))]
        steps = ordered_steps(entry.definition)
        states: dict[str, StepState] = {step.id: StepState() for step in entry.definition.steps}
        # An analyst-closed case: every step worked; an open one: the first few.
        worked = len(steps) if closed_by_person else min(len(steps), rng.randint(1, 3))
        # Each worked step waits then takes a few minutes; the whole is scaled down to
        # fit the time the case had, so a case opened minutes ago still shows progress.
        gaps = [(rng.randint(1, 6), rng.randint(2, 25)) for _ in steps[:worked]]
        span = max((end - attached).total_seconds(), 0.0)
        needed = float(sum(wait + took for wait, took in gaps) * 60) or 1.0
        scale = min(1.0, span / needed)
        clock = attached
        for step, (wait, took) in zip(steps[:worked], gaps):
            st = states[step.id]
            if st.status in _FINISHED_STEP:
                continue  # a decision already ruled it out
            started = clock + timedelta(seconds=wait * 60 * scale)
            finished = min(started + timedelta(seconds=took * 60 * scale), end)
            clock = finished
            st.status = "done"
            st.started_at, st.completed_at, st.completed_by = _demo_iso(started), _demo_iso(finished), person
            st.note = _DEMO_STEP_NOTES.get(step.kind, "")
            st.revision = 1
            if step.kind == "decision":
                option = _demo_decision_option(step, case.verdict)
                if option is not None:
                    st.decision = {"option_id": option.id, "label": option.label, "by": person,
                                   "at": _demo_iso(finished)}
                    for skipped in option.marks_not_applicable:
                        later = states.get(skipped)
                        if later is not None and later.status == "todo":
                            later.status = "not_applicable"
                            later.reason = "The decision ruled this step out."
                            later.completed_by, later.completed_at = person, _demo_iso(finished)
                            later.revision = 1
            elif step.kind in ("action", "record"):
                st.action_record = {"performed_by": person, "performed_at": _demo_iso(finished),
                                    "where": f"DEMO-{rng.randint(1000, 9999)}", "outcome": "Done."}
        if closed_by_person:
            # Optional steps nobody needed are recorded as not applicable, so the run
            # reads as finished (a run completes on its required steps).
            for step in steps:
                st = states[step.id]
                if st.status not in _FINISHED_STEP and not step.required:
                    st.status, st.reason, st.revision = "not_applicable", "Not needed for this case.", 1
        run = RunbookRun(
            run_id=demo_runbook_run_id(seed, case.case_id, entry.id),
            case_id=case.case_id, runbook_id=entry.id, version=entry.version, title=entry.definition.title,
            snapshot=entry.definition, attached_by="fallback" if plan.tier == 0 else "rule",
            # The match explanation, as a live attachment stores it (the Why attached
            # popover reads it).
            attached_reason=plan.explanation.model_dump(mode="json"),
            attached_at=_demo_iso(attached), attached_actor="runbook_selector", steps=states, revision=1,
        )
        required_open = any(step.required and states[step.id].status not in _FINISHED_STEP for step in steps)
        if not required_open:
            run.status = "completed"
            run.completed_at = _demo_iso(clock)
        runs.append(run)
    return runs


def _demo_audit_row(case_id: str, label: str, ts: str, action: str, actor: str, actor_type: str, summary: str,
                    tool_input: dict[str, Any]) -> dict[str, Any]:
    """One Demo runbook audit row as keyword arguments of ``record_strict``, in the
    shape the live engine writes (``runbook_runs``)."""
    from ..constants import ActionType
    from ..models import AuditTarget

    return {
        "ts": ts, "action_type": ActionType.RUNBOOK, "surface": "runbook", "actor": actor,
        "actor_type": actor_type, "action": action, "outcome": "success", "case_id": case_id,
        "target": AuditTarget(type="case", id=case_id, label=label or case_id),
        "result_summary": summary, "tool_input": tool_input,
    }


def demo_evidence_audit_row(run: Any, case: Any, step_id: str, result: Any) -> dict[str, Any]:
    """The ``step.evidence_collected`` row of one stored lookup result, as the live
    engine writes it (``runbook_runs._store_lookup``), dated when the lookup ran: the
    system actor for an automatic lookup, else the person who ran it."""
    from ..models import RUNBOOK_SYSTEM_RUNNER
    from .runbook_runs import lookup_evidence_summary

    case_id = str(getattr(case, "case_id", "") or run.case_id)
    automatic = result.ran_by == RUNBOOK_SYSTEM_RUNNER
    return _demo_audit_row(
        case_id, str(getattr(case, "case_number", "") or ""), str(result.ran_at or run.attached_at),
        "step.evidence_collected", result.ran_by or "analyst", "system" if automatic else "human",
        lookup_evidence_summary(result),
        {"run_id": run.run_id, "step_id": step_id, "tool": result.tool, "status": result.status,
         "count": result.count, "count_relation": result.count_relation},
    )


def demo_runbook_audit_rows(run: Any, case: Any) -> list[dict[str, Any]]:
    """The Demo audit rows of one seeded run, oldest first, as keyword arguments of
    ``record_strict``: the rows the live engine writes for the same work
    (``runbook_runs``), dated when the seeded work happened, so a seeded case's
    activity feed and the audit log tell the story its Runbook tab shows (§3.5, §3.6).

    ``run.attached`` (the runbook selector), ``run.started`` and one row per worked
    step (``step.decision_recorded``, ``step.action_recorded`` or ``step.updated``,
    by the person who worked it), one ``step.evidence_collected`` per lookup result
    the run holds (:func:`demo_evidence_audit_row`; a planned run holds none, the
    collector writes those rows as it stores each result), then ``run.completed`` for
    a finished run; ordered by time. Pure."""
    case_id = str(getattr(case, "case_id", "") or run.case_id)
    label = str(getattr(case, "case_number", "") or "")

    def row(ts: str, action: str, actor: str, actor_type: str, summary: str,
            tool_input: dict[str, Any]) -> dict[str, Any]:
        return _demo_audit_row(case_id, label, ts, action, actor, actor_type, summary, tool_input)

    title, version = run.title, run.version
    rows = [row(run.attached_at, "run.attached", "runbook_selector", "system",
                f"Runbook {title} v{version} attached.",
                {"run_id": run.run_id, "runbook_id": run.runbook_id, "version": version,
                 "attached_by": run.attached_by, "trigger": "demo_seed"})]
    # Steps a recorded decision ruled out are part of that decision's row, as live.
    ruled_out: set[str] = set()
    for step in getattr(run.snapshot, "steps", None) or []:
        state = run.steps.get(step.id)
        decision = state.decision if state is not None else None
        if not decision:
            continue
        for option in getattr(step, "options", None) or []:
            if option.id == decision.get("option_id"):
                ruled_out.update(option.marks_not_applicable)
    worked = sorted(
        ((step_id, st) for step_id, st in run.steps.items()
         if st.status != "todo" and step_id not in ruled_out),
        key=lambda item: (str(item[1].completed_at or run.completed_at or run.attached_at), item[0]),
    )
    people = [st.completed_by for _sid, st in worked if st.completed_by]
    if worked:
        first = worked[0][1]
        rows.append(row(str(first.started_at or first.completed_at or run.attached_at), "run.started",
                        people[0] if people else "analyst", "human",
                        f"Work started on runbook {title}.", {"run_id": run.run_id}))
    for step_id, st in worked:
        action = ("step.decision_recorded" if st.decision else
                  "step.action_recorded" if st.action_record else "step.updated")
        rows.append(row(str(st.completed_at or run.completed_at or run.attached_at), action,
                        st.completed_by or (people[0] if people else "analyst"), "human",
                        f"Runbook step {step_id[:64]} updated.",
                        {"run_id": run.run_id, "step_id": step_id}))
    for step in getattr(run.snapshot, "steps", None) or []:
        state = run.steps.get(step.id)
        for item in (state.evidence if state is not None else []):
            if item.kind == "lookup_result" and item.lookup is not None:
                rows.append(demo_evidence_audit_row(run, case, step.id, item.lookup))
    if run.status == "completed" and run.completed_at:
        rows.append(row(run.completed_at, "run.completed", people[-1] if people else "analyst", "human",
                        f"Runbook {title} completed: every required step is done or not applicable.",
                        {"run_id": run.run_id}))
    # Oldest first by instant (a stable sort: rows at the same instant keep the order
    # above, so the attachment precedes what it started).
    rows.sort(key=lambda r: _demo_moment(r["ts"], 0))
    return rows


async def seed_demo_runbook_runs(
    store: Any, cases: list[Case], catalog: Any, *, prefs: Preferences, seed: int, now_millis: int,
    audit: Any = None,
) -> int:
    """Write :func:`plan_demo_runbook_runs` into the Demo run store: each case's run
    document (never over a case that already has runs) and its month ledger row, so the
    Runbook tab, the progress chips and the library metrics show Demo data from the
    first paint. ``audit`` is the Demo audit: each written run's rows
    (:func:`demo_runbook_audit_rows`) are appended once its document is stored, so the
    activity feed and the audit log show the seeded work too. Returns the runs written.
    A failed write is logged and skipped; it never stops Demo Mode. The runs hold no
    lookup result: once the seeded stack is the active one, the caller starts
    :func:`schedule_demo_runbook_lookups`, which collects them with the live engine."""
    import logging

    from .runbook_runs import _ledger_row  # the engine's own projection: seeded rows match live ones

    log = logging.getLogger("tlsoc.engine.demo_generator")
    by_id = {str(c.case_id): c for c in cases}
    written = 0
    for run in plan_demo_runbook_runs(cases, catalog, prefs=prefs, seed=seed, now_millis=now_millis):
        def _change(existing: list[Any], _run: Any = run) -> tuple[list[Any] | None, bool]:
            return (None, False) if existing else ([_run], True)
        try:
            added, _case_runs = await store.mutate(run.case_id, _change)
            if not added:
                continue
            await store.upsert_ledger_row(_ledger_row(run))
            written += 1
        except Exception as exc:  # noqa: BLE001 - a seeded run never blocks Demo Mode
            log.warning("demo runbook run for case %s not seeded: %s", str(run.case_id)[:80], exc)
            continue
        if audit is None:
            continue
        try:
            for fields in demo_runbook_audit_rows(run, by_id.get(str(run.case_id))):
                await audit.record_strict(**fields)
        except Exception as exc:  # noqa: BLE001 - the seeded run stands; its rows are best effort
            log.warning("demo runbook audit rows for case %s not written: %s", str(run.case_id)[:80], exc)
    return written


# --------------------------------------------------------------------------- #
# The seeded runs' lookups, collected by the live engine (Round 14 SPEC §3.5,
# §4.10.8, §4.10.18)
# --------------------------------------------------------------------------- #
#: An automatic (``on_attach``) lookup of a seeded run is collected this many seconds
#: after the attachment (seeded per step), always before a person starts a step.
_DEMO_LOOKUP_DELAY_S = (3, 40)


class DemoLookup(NamedTuple):
    """One lookup a seeded run's step collects: the step, when it ran, who ran it."""

    step: Any
    ran_at: datetime
    ran_by: str


def demo_lookup_schedule(run: Any, *, seed: int, now: datetime) -> list[DemoLookup]:
    """The lookups a seeded run's steps collect, in reading order, as a live run
    collects them (§4.10.8): every ``on_attach`` lookup right after the attachment, by
    the system actor, whatever later happened to its step; an ``on_demand`` one only on
    a step a person finished, run by that person when they started it. A step nobody
    finished keeps "Run lookup". Every moment lies between the attachment and ``now``,
    an automatic one no later than the first step a person started, and each is a whole
    second (a stored result's ``ran_at`` reads back as exactly the moment it ran at).
    Pure and deterministic for a seed."""
    from ..models import RUNBOOK_SYSTEM_RUNNER
    from .runbook_runs import ordered_steps

    now_ms = int(now.timestamp() * 1000)
    attached = min(_demo_moment(run.attached_at, now_ms), now)
    started = [_demo_moment(st.started_at, now_ms) for st in run.steps.values() if st.started_at]
    limit = max(attached, min([*started, now]))
    out: list[DemoLookup] = []
    for step in ordered_steps(run.snapshot):
        template = getattr(step, "lookup", None)
        if step.kind != "lookup" or template is None:
            continue
        if template.run == "on_attach":
            rng = random.Random(f"{seed}:{run.case_id}:{run.runbook_id}:lookup:{step.id}")
            ran_at = attached + timedelta(seconds=rng.randint(*_DEMO_LOOKUP_DELAY_S))
            if ran_at >= limit:
                # A run worked within seconds of its attachment: halfway to the first
                # step a person started (or to now).
                ran_at = attached + (limit - attached) / 2
            out.append(DemoLookup(step, ran_at.replace(microsecond=0), RUNBOOK_SYSTEM_RUNNER))
            continue
        st = run.steps.get(step.id)
        if st is not None and st.status == "done" and st.started_at and st.completed_by:
            ran_at = min(_demo_moment(st.started_at, now_ms), now)
            out.append(DemoLookup(step, ran_at.replace(microsecond=0), st.completed_by))
    return out


def _holds_lookup_result(run: Any, step_id: str) -> bool:
    state = run.steps.get(step_id)
    return state is not None and any(item.kind == "lookup_result" for item in state.evidence)


def _store_if_absent(run_id: str, step_id: str, result: Any, *, drop_table: bool = False) -> Callable[..., Any]:
    """A run-store change that stores ``result`` as the step's lookup evidence only
    while the step holds no lookup result: a result a person got with "Run lookup"
    meanwhile stands, and a second collection writes nothing. A table that would take
    the case past its lookup-evidence budget is dropped with the store's note, as
    ``RunbookRunStore.record_lookup_result`` does. Never changes a step's status or
    revision."""
    from ..models import RUNBOOK_CASE_EVIDENCE_MAX_BYTES, StepEvidence, StepState
    from ..stores.runbook_runs import EVIDENCE_LIMIT_NOTE, lookup_table_bytes

    def change(runs: list[Any]) -> tuple[list[Any] | None, Any]:
        run = next((r for r in runs if r.run_id == run_id), None)
        if run is None or run.status == "abandoned" or not any(s.id == step_id for s in run.snapshot.steps):
            return None, None
        if _holds_lookup_result(run, step_id):
            return None, None
        state = run.steps.get(step_id) or StepState()
        stored = result.model_copy(deep=True)
        if stored.table is not None:
            run.steps[step_id] = state.model_copy(update={
                "evidence": [*state.evidence, StepEvidence(kind="lookup_result", lookup=stored)],
            })
            if drop_table or lookup_table_bytes(runs) > RUNBOOK_CASE_EVIDENCE_MAX_BYTES:
                stored = stored.model_copy(update={"table": None, "table_kind": None, "reason": EVIDENCE_LIMIT_NOTE})
        run.steps[step_id] = state.model_copy(update={
            "evidence": [*state.evidence, StepEvidence(kind="lookup_result", lookup=stored)],
        })
        return runs, stored

    return change


async def collect_demo_runbook_lookups(
    state: Any, cases: Iterable[Case], *, seed: int, now: datetime | None = None,
) -> int:
    """Run the seeded runs' lookups with the live engine against the Demo stores, once
    Demo Mode is active (§3.5, §4.10.8, §4.10.18). Each lookup of
    :func:`demo_lookup_schedule` goes through ``runbook_runs.execute_lookup`` at the
    moment the seed gives (its window is clamped there): the template is bound from the
    case and its member events, and the Demo log sources, the Demo case store and the
    campaign store are read exactly as "Run lookup" reads them. So a seeded step shows
    what the same lookup returns live, never a made-up figure. Each result is stored on
    its step in the Demo run store, audited in the Demo audit
    (``step.evidence_collected``, dated when it ran) and announced with a
    ``case.runbook`` frame.

    Only the seeded runs (:func:`demo_runbook_run_id`) of ``cases`` are touched, and
    only their steps that hold no lookup result yet. A lookup run in a person's name
    that could not run is not stored ("Run lookup" stores nothing then). Bounded as
    background lookups are (``runbook_runs.BACKGROUND_RUNS_AT_ONCE`` runs at once, two
    lookups at once per run), never a model call ($0), and every result is dropped
    once Demo Mode switches. Does nothing while Demo Mode is off, so a Demo case's
    values never query real sources. Never raises; returns the results stored."""
    import asyncio
    import logging

    from ..models import RUNBOOK_SYSTEM_RUNNER
    from ..stores.runbook_runs import RunDocumentFull
    from . import runbook_runs as engine

    log = logging.getLogger("tlsoc.engine.demo_generator")
    if not getattr(state, "demo_active", False):
        return 0
    identity = engine._demo_identity(state)
    stack = engine._bind_stack(state)
    moment = now or datetime.now(timezone.utc)
    by_id: dict[str, Case] = {}
    for case in cases:
        by_id.setdefault(str(case.case_id), case)
    if not by_id:
        return 0
    try:
        stored = await stack.runs.get_many(list(by_id))
    except Exception as exc:  # noqa: BLE001 - the seeded runs stand without their results
        log.warning("demo runbook lookups not collected: the runs could not be read: %s", exc)
        return 0

    def same_stack() -> bool:
        return engine._demo_identity(state) == identity

    async def one(case: Case, run: Any, item: DemoLookup, events: list[Any] | None) -> bool:
        async with engine._run_gate(run.run_id):
            if not same_stack():
                return False
            result = await engine.execute_lookup(state, case, item.step.lookup, ran_by=item.ran_by,
                                                 now=item.ran_at, events=events, load_events=False)
            if not same_stack() or (result.status == "error" and item.ran_by != RUNBOOK_SYSTEM_RUNNER):
                return False
            case_id = str(case.case_id)
            try:
                try:
                    written, case_runs = await stack.runs.mutate(
                        case_id, _store_if_absent(run.run_id, item.step.id, result))
                except RunDocumentFull:
                    if result.table is None:
                        raise
                    written, case_runs = await stack.runs.mutate(
                        case_id, _store_if_absent(run.run_id, item.step.id, result, drop_table=True))
            except Exception as exc:  # noqa: BLE001 - one lookup never stops the others
                log.warning("demo lookup %s for case %s not stored: %s", item.step.id[:64], case_id[:80], exc)
                return False
            if written is None:
                return False
            try:
                await stack.audit.record_strict(**demo_evidence_audit_row(run, case, item.step.id, written))
            except Exception as exc:  # noqa: BLE001 - the stored result stands; its row is best effort
                log.warning("demo lookup row for case %s not written: %s", case_id[:80], exc)
            engine._publish_frames(stack, case_id, [r for r in case_runs.runs if r.run_id == run.run_id],
                                   case_runs.revision)
            return True

    async def per_run(case: Case, run: Any, pending: list[DemoLookup]) -> int:
        async with engine._background_gate():
            if not same_stack():
                return 0
            events = await engine._case_events(state, case)
            outcomes = await asyncio.gather(*(one(case, run, item, events) for item in pending),
                                            return_exceptions=True)
        for outcome in outcomes:
            if isinstance(outcome, BaseException):
                log.warning("demo lookup for case %s failed: %s", str(case.case_id)[:80], outcome)
        return sum(1 for outcome in outcomes if outcome is True)

    work = []
    for case_id, case_runs in stored.items():
        case = by_id.get(case_id)
        if case is None:
            continue
        for run in case_runs.runs:
            if run.status == "abandoned" or run.run_id != demo_runbook_run_id(seed, case_id, run.runbook_id):
                continue
            pending = [item for item in demo_lookup_schedule(run, seed=seed, now=moment)
                       if not _holds_lookup_result(run, item.step.id)]
            if pending:
                work.append(per_run(case, run, pending))
    totals = await asyncio.gather(*work, return_exceptions=True)
    return sum(total for total in totals if isinstance(total, int))


def seed_demo_case_evidence(state: Any, cases: Iterable[Case]) -> int:
    """Keep each seeded case's own detection rows in its Demo source (FX3b2): the rows
    the case was built from, carrying its rule and entity and dated inside its window
    (``demo_sources.NativeDemoSource.record_case_history``). Seeded cases are saved
    straight to the Demo store, so without this their rule would have no rows: the
    rule sheet would show no alerts, Logs nothing and the seeded runbook lookups
    nothing for the case. Synchronous and in memory (no I/O, $0), idempotent per case,
    bounded per source; a case whose rule its source never raises (the tuner's noise,
    which keeps its Demo-only rule) adds nothing. Does nothing while Demo Mode is off.
    Never raises; returns the rows recorded."""
    import logging

    if not getattr(state, "demo_active", False):
        return 0
    connector_for = getattr(state, "demo_source_connector", None)
    if not callable(connector_for):
        return 0
    prefs = state.execution_prefs
    recorded = 0
    for case in cases:
        try:
            source = connector_for(str(getattr(case, "source_id", "") or ""))
            record = getattr(source, "record_case_history", None)
            if callable(record):
                recorded += int(record(case, prefs) or 0)
        except Exception as exc:  # noqa: BLE001 - one case's rows never stop the others
            logging.getLogger("tlsoc.engine.demo_generator").warning(
                "demo evidence for case %s not recorded: %s", str(getattr(case, "case_id", ""))[:80], exc)
    return recorded


def schedule_demo_runbook_lookups(state: Any, cases: Iterable[Case], *, seed: int) -> Any | None:
    """Start :func:`collect_demo_runbook_lookups` in the background, as a live run's
    ``on_attach`` lookups start: the caller (Demo Mode's enable and reset, right after
    the seeded stack becomes the active one) never waits for log reads. The task is
    tracked with the background lookups, so ``runbook_runs.wait_for_background_lookups``
    waits for it. ``None`` when it could not start (Demo Mode is off, or the mutation
    fence is closed during a reset).

    First, synchronously, the seeded cases' own detection rows are kept in their Demo
    sources (:func:`seed_demo_case_evidence`): the lookups started here read those
    sources, and so do the rule sheet and Logs from the moment Demo Mode is on."""
    import asyncio
    import logging

    from . import runbook_runs as engine

    if not getattr(state, "demo_active", False):
        return None
    cases = list(cases)
    seed_demo_case_evidence(state, cases)
    coro = collect_demo_runbook_lookups(state, cases, seed=seed)
    try:
        spawn = getattr(state, "spawn_mutation_task", None)
        task = spawn(coro, name="demo-runbook-lookups") if callable(spawn) else asyncio.ensure_future(coro)
    except Exception as exc:  # noqa: BLE001 - the seeded runs stand; their steps keep "Run lookup"
        coro.close()
        logging.getLogger("tlsoc.engine.demo_generator").info("demo runbook lookups not started: %s", exc)
        return None
    engine._BACKGROUND.add(task)
    task.add_done_callback(engine._BACKGROUND.discard)
    return task
