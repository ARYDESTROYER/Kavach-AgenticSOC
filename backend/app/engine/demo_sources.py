"""Standards-faithful native sources for the isolated Demo Mode.

The original demo generator emits ECS-shaped values.  That remains useful for
historical fixtures, but a live product tour should exercise the same parsing
boundary as a real deployment.  This module therefore renders five synthetic,
vendor-native wire contracts and feeds them through the production receivers:

* Splunk HTTP Event Collector envelopes (``access_combined`` and ES risk events),
* IBM QRadar LEEF 2.0 events and SIEM offense response objects,
* Wazuh ``archives.json`` events and ``alerts.json`` rule-bearing alerts, and
* RFC 5424 syslog with structured data, and
* Microsoft Graph Entra ID sign-in / Identity Protection records.

Every value is deterministic for a caller-supplied ``random.Random`` and is
synthetic, labelled data.  There is no network access and no additional runtime
dependency.  The resulting :class:`~app.models.RawEvent` values retain source
provenance, enter the normal OCSF/parser path, and remain untrusted log data (#9).
Each adapter owns a bounded recent ring so the demo log browser is populated the
instant Demo Mode starts and cannot grow without bound.
"""

from __future__ import annotations

import hashlib
import json
import random
from collections import deque
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ..config import Preferences
from ..connectors.base import ConnectionTest, QueryRendering, SearchResult, StructuredQuery
from ..connectors.receivers.syslog import SyslogReceiver
from ..connectors.receivers.webhook import HECReceiver, WebhookReceiver
from ..constants import IngestMode, SourceType
from ..models import Cursor, RawEvent
from ..utils import now_utc, relative_to_millis, stable_signature, to_millis
from . import demo_generator as gen
from .mitre import technique as mitre_technique


@dataclass(frozen=True)
class DemoSourceSpec:
    """Presentation and runtime contract for one synthetic native source."""

    key: str
    source_id: str
    display_name: str
    source_type: SourceType
    category: str
    ingest_mode: IngestMode
    protocol: str
    wire_format: str
    rate_share: float

    def model_dump(self) -> dict[str, Any]:
        """A JSON-safe shape for API overlays without importing Pydantic here."""
        return {
            "key": self.key,
            "source_id": self.source_id,
            "display_name": self.display_name,
            "source_type": self.source_type.value,
            "category": self.category,
            "ingest_mode": self.ingest_mode.value,
            "protocol": self.protocol,
            "wire_format": self.wire_format,
            "rate_share": self.rate_share,
        }


# Dict insertion order is the stable dashboard order and deterministic cadence.
DEMO_SOURCE_SPECS: dict[str, DemoSourceSpec] = {
    "splunk": DemoSourceSpec(
        key="splunk",
        source_id="demo-splunk",
        display_name="Splunk Enterprise Security — HEC",
        source_type=SourceType.SPLUNK,
        category="siem",
        ingest_mode=IngestMode.PUSH_HTTP,
        protocol="HEC / HTTPS",
        wire_format="Splunk HEC JSON (access_combined + ES risk)",
        rate_share=0.24,
    ),
    "qradar": DemoSourceSpec(
        key="qradar",
        source_id="demo-qradar",
        display_name="IBM QRadar SIEM",
        source_type=SourceType.QRADAR,
        category="siem",
        ingest_mode=IngestMode.PUSH_HTTP,
        protocol="LEEF 2.0 + REST",
        wire_format="LEEF 2.0 events + /api/siem/offenses JSON",
        rate_share=0.16,
    ),
    "wazuh": DemoSourceSpec(
        key="wazuh",
        source_id="demo-wazuh",
        display_name="Wazuh Manager — endpoint telemetry",
        source_type=SourceType.WAZUH,
        category="edr",
        ingest_mode=IngestMode.PUSH_HTTP,
        protocol="Wazuh JSON",
        wire_format="archives.json events + alerts.json alerts",
        rate_share=0.24,
    ),
    "syslog": DemoSourceSpec(
        key="syslog",
        source_id="demo-syslog",
        display_name="Network & Linux — RFC 5424 Syslog",
        source_type=SourceType.SYSLOG,
        category="transport",
        ingest_mode=IngestMode.PUSH_SYSLOG,
        protocol="RFC 5424 / RFC 3164",
        wire_format="RFC 5424 structured + RFC 3164 BSD syslog",
        rate_share=0.16,
    ),
    "entra": DemoSourceSpec(
        key="entra",
        source_id="demo-entra-id",
        display_name="Microsoft Entra ID / Active Directory",
        # The existing Microsoft cloud connector enum is Sentinel; the demo wire
        # contract itself is Graph auditLogs/signIns + Identity Protection JSON.
        source_type=SourceType.SENTINEL,
        category="identity",
        ingest_mode=IngestMode.PUSH_HTTP,
        protocol="Microsoft Graph / HTTPS",
        wire_format="Entra ID auditLogs/signIns + Identity Protection JSON",
        rate_share=0.20,
    ),
}

# Compatibility lookup only.  Iterating DemoSourceMap yields the five new sources,
# so no legacy row leaks into the UI/API overlay.
LEGACY_SOURCE_ALIASES: dict[str, str] = {
    "siem": "splunk",
    "xdr": "qradar",
    "edr": "wazuh",
}


@dataclass(frozen=True)
class NativeSignal:
    """Source-neutral facts that a renderer projects into a native contract."""

    native_id: str
    timestamp_millis: int
    source_ip: str
    user: str
    host: str
    action: str
    outcome: str
    severity: float
    rule_id: str
    rule_name: str
    message: str
    native_alert: bool = False
    story_id: str = ""
    techniques: tuple[str, ...] = ()


@dataclass(frozen=True)
class NativeEmission:
    """One exact wire payload plus the RawEvents parsed from that payload."""

    source_key: str
    source_id: str
    wire_format: str
    payload: str
    events: tuple[RawEvent, ...]
    native_alert: bool
    story_id: str = ""


_NATIVE_ALERT_RULES: dict[str, tuple[str, str]] = {
    "splunk": ("LP-ES-RISK-0099", "Known scanner raised a low-risk notable"),
    "qradar": ("LP QRadar: low-confidence scanner offense", "Low-confidence scanner offense"),
    "wazuh": ("100190", "Repeated authentication failure from a known scanner"),
    "entra": (
        "Entra ID Protection: low-confidence unfamiliar sign-in properties",
        "Low-confidence unfamiliar sign-in properties",
    ),
}
SOURCE_NATIVE_ALERT_KEYS: tuple[str, ...] = tuple(_NATIVE_ALERT_RULES)
SYSLOG_DETECTION_RULE_IDS: frozenset[str] = frozenset(
    gen.NATIVE_STORY_RULE_IDS["syslog"].values()
)

# The deterministic mock provider imports this mapping through demo_generator.  Values
# here are source-native rule identities, not hidden demo control strings.
NATIVE_RULE_TO_STORY = gen.NATIVE_RULE_TO_STORY


def _iso_millis(ts_millis: int) -> str:
    return (
        datetime.fromtimestamp(ts_millis / 1000.0, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _wazuh_timestamp(ts_millis: int) -> str:
    """Wazuh JSON examples use an ISO timestamp with the compact ``+0000`` zone."""
    dt = datetime.fromtimestamp(ts_millis / 1000.0, tz=timezone.utc)
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{dt.microsecond // 1000:03d}+0000"


def _stable_int(value: str, *, minimum: int = 10_000, span: int = 900_000) -> int:
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return minimum + int.from_bytes(digest[:8], "big") % span


def _safe_text(value: str, *, delimiter: str | None = None) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ")
    if delimiter:
        text = text.replace(delimiter, " ")
    return text


def _sd_escape(value: str) -> str:
    return _safe_text(value).replace("\\", "\\\\").replace('"', '\\"').replace("]", "\\]")


def render_splunk_hec(signal: NativeSignal) -> str:
    """Render a valid Splunk HEC ``/collector/event`` envelope.

    Normal traffic uses the standard Apache ``access_combined`` event body and flat
    HEC indexed fields.  Native detections use the Enterprise Security risk-event
    vocabulary (risk object/type/score/message + originating search name).
    """
    common = {
        "event_id": signal.native_id,
        "src_ip": signal.source_ip,
        "user": signal.user,
        "dest_host": signal.host,
        "action": signal.action,
        "outcome": signal.outcome,
        "severity": signal.severity,
        "rule_id": signal.rule_id,
        "rule_name": signal.rule_name,
    }
    if signal.native_alert:
        event: str | dict[str, Any] = {
            **common,
            "risk_object": signal.user or signal.host,
            "risk_object_type": "user" if signal.user else "system",
            "risk_score": int(round(signal.severity)),
            "risk_message": signal.message,
            "search_name": signal.rule_id,
            "source": "Splunk Enterprise Security",
            "mitre_technique_id": list(signal.techniques),
            "message": signal.message,
        }
        sourcetype = "stash"
        index = "risk"
    else:
        event = (
            f'{signal.source_ip} - {signal.user or "-"} '
            f'[{datetime.fromtimestamp(signal.timestamp_millis / 1000, tz=timezone.utc).strftime("%d/%b/%Y:%H:%M:%S +0000")}] '
            f'"GET /api/v2/applications HTTP/1.1" 200 842 '
            f'"https://portal.demo.example/" "Mozilla/5.0"'
        )
        sourcetype = "access_combined"
        index = "security"
    envelope = {
        "time": round(signal.timestamp_millis / 1000.0, 3),
        "host": signal.host,
        "source": "lumenpay:demo",
        "sourcetype": sourcetype,
        "index": index,
        "event": event,
        # HEC requires indexed fields to be flat.  Keeping the common projection here
        # lets the production HEC receiver normalise a raw access line without a custom
        # log parser, while the event itself remains standards-faithful access_combined.
        "fields": {**common, "tenant": "LumenPay", "synthetic": "true"},
    }
    return json.dumps(envelope, sort_keys=True, separators=(",", ":"))


def render_qradar_leef(signal: NativeSignal) -> str:
    """Render a QRadar LEEF 2.0 event behind an RFC 5424 syslog header."""
    attrs = [
        ("devTimeFormat", "yyyy-MM-dd'T'HH:mm:ss.SSSX"),
        ("devTime", _iso_millis(signal.timestamp_millis)),
        ("src", signal.source_ip),
        ("dst", "10.80.0.12"),
        ("usrName", signal.user),
        ("devName", signal.host),
        # QRadar's native LEEF `sev` is a 1..10 magnitude. It stays on the wire exactly as
        # a real appliance would send it, and `demoSeverity` carries the SAME rating on
        # the canonical 0..100 scale beside it — the pattern the Wazuh and syslog demo
        # receivers already use. The demo overlay is a read-time fixture and never
        # registers a SourceInstance, so it has nowhere to DECLARE a 0..10 ceiling; a
        # parallel honest field is how it normalises without one.
        ("sev", str(max(1, min(10, int(round(signal.severity / 10.0)))))),
        ("demoSeverity", str(signal.severity)),
        ("cat", "Authentication" if "auth" in signal.action.lower() else "Application"),
        ("proto", "TCP"),
        ("action", signal.action),
        ("status", signal.outcome),
        ("name", signal.rule_name),
        ("message", signal.message),
    ]
    payload = "^".join(f"{key}={_safe_text(value, delimiter='^')}" for key, value in attrs)
    procid = _stable_int(signal.native_id, minimum=1000, span=8000)
    header = (
        f"<134>1 {_iso_millis(signal.timestamp_millis)} qradar.soc.demo.example "
        f"ecs-ec {procid} LEEF -"
    )
    leef = (
        f"LEEF:2.0|LumenPay|Agentic SOC Demo Sources|1.0|{signal.rule_id}|^|{payload}"
    )
    return f"{header} {leef}"


def render_qradar_offense(signal: NativeSignal) -> str:
    """Render a QRadar ``/api/siem/offenses`` response object.

    QRadar offense type ids are deployment-owned numeric values resolved through
    ``GET /siem/offense_types``. The demo uses a stable synthetic numeric id while
    keeping ``offense_source`` as the source-IP string; it never puts a display
    label into the numeric field.
    """
    offense_id = _stable_int(signal.native_id)
    rule_id = _stable_int(signal.rule_id, minimum=100_000, span=800_000)
    log_source_id = _stable_int("lumenpay-qradar-demo-log-source", minimum=100, span=900)
    source_address_id = _stable_int(signal.source_ip, minimum=1_000, span=900_000)
    destination_address_id = _stable_int(signal.host, minimum=1_000, span=900_000)
    first_seen = signal.timestamp_millis - 60_000
    obj = {
        "id": offense_id,
        "description": signal.rule_id,
        "assigned_to": None,
        "categories": ["Authentication", "Suspicious Activity"],
        "category_count": 2,
        "policy_category_count": 1,
        "security_category_count": 1,
        "close_time": None,
        "closing_user": None,
        "closing_reason_id": None,
        "credibility": 8,
        "relevance": 9,
        # Native QRadar `severity`/`magnitude` are 1..10 and stay on the wire verbatim;
        # `_demo.severity` carries the same rating on the canonical 0..100 scale, which is
        # what the receiver normalises through (see `render_qradar_leef`).
        "severity": max(1, min(10, int(round(signal.severity / 10.0)))),
        "magnitude": max(1, min(10, int(round(signal.severity / 10.0)))),
        "_demo": {"severity": signal.severity},
        "destination_networks": ["LumenPay DMZ", "LumenPay Corporate"],
        "source_network": "other-remote",
        "device_count": 2,
        "event_count": 12,
        "flow_count": 3,
        "inactive": False,
        "last_updated_time": signal.timestamp_millis,
        "local_destination_count": 2,
        "offense_source": signal.source_ip,
        # Numeric IDs are appliance-specific; 42 is a deterministic synthetic
        # Source-IP type id for this offline contract, not a portable IBM enum.
        "offense_type": 42,
        "protected": False,
        "follow_up": True,
        "remote_destination_count": 1,
        "source_count": 1,
        "start_time": first_seen,
        "status": "OPEN",
        "username_count": 1,
        "source_address_ids": [source_address_id],
        "local_destination_address_ids": [destination_address_id],
        "domain_id": None,
        "last_persisted_time": signal.timestamp_millis,
        "first_persisted_time": first_seen,
        "rules": [{"id": rule_id, "type": "CRE_RULE"}],
        "log_sources": [{
            "id": log_source_id,
            "name": "LumenPay Universal LEEF Demo",
            "type_id": 4001,
            "type_name": "Universal LEEF",
        }],
    }
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _wazuh_base(signal: NativeSignal) -> dict[str, Any]:
    return {
        "timestamp": _wazuh_timestamp(signal.timestamp_millis),
        "agent": {"id": "003", "name": signal.host, "ip": "10.20.6.10"},
        "manager": {"name": "wazuh-manager"},
        "id": signal.native_id,
        "full_log": signal.message,
        "decoder": {"name": "json"},
        "data": {
            "srcip": signal.source_ip,
            "srcuser": signal.user,
            "dstuser": signal.user,
            "desthost": signal.host,
            "action": signal.action,
            "outcome": signal.outcome,
            "event_type": signal.rule_id,
            "event_name": signal.rule_name,
            "severity": signal.severity,
        },
        "location": "journald",
    }


def render_wazuh_archive(signal: NativeSignal) -> str:
    """Render one Wazuh ``archives.json`` record (all collected events, no rule)."""
    return json.dumps(_wazuh_base(signal), sort_keys=True, separators=(",", ":"))


def render_wazuh_alert(signal: NativeSignal) -> str:
    """Render one Wazuh ``alerts.json`` record with a standards-shaped rule block."""
    obj = _wazuh_base(signal)
    level = max(1, min(16, int(round(signal.severity / 100.0 * 16))))
    rule: dict[str, Any] = {
        "id": signal.rule_id,
        "level": level,
        "description": signal.rule_name,
        "firedtimes": 4,
        "mail": False,
        "groups": ["syslog", "authentication_failed", "demo"],
    }
    if signal.techniques:
        resolved = [mitre_technique(item) for item in signal.techniques]
        resolved = [item for item in resolved if item is not None]
        tactics = list(dict.fromkeys(
            tactic
            for item in resolved
            for tactic in (item.get("tactics") or [])
        ))
        rule["mitre"] = {
            "id": [str(item["id"]) for item in resolved],
            "tactic": tactics,
            "technique": [str(item.get("name") or item["id"]) for item in resolved],
        }
    obj["rule"] = rule
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def render_rfc5424(signal: NativeSignal) -> str:
    """Render an RFC 5424 message with one private structured-data element."""
    # Authpriv facility (10).  RFC severities run high-to-low in the opposite
    # direction from OCSF; normal traffic is informational (6), incident bursts error
    # (3).  These are raw events, never mislabeled as a source-native alert.
    syslog_severity = 3 if signal.severity >= 70 else 6
    pri = 10 * 8 + syslog_severity
    procid = _stable_int(signal.native_id, minimum=1000, span=8000)
    params = {
        "eventId": signal.native_id,
        "src": signal.source_ip,
        "user": signal.user,
        "destHost": signal.host,
        "rule": signal.rule_id,
        "eventName": signal.rule_name,
        "action": signal.action,
        "outcome": signal.outcome,
        "demoSeverity": str(signal.severity),
        "mitre": ",".join(signal.techniques),
    }
    structured = " ".join(f'{key}="{_sd_escape(value)}"' for key, value in params.items())
    return (
        f"<{pri}>1 {_iso_millis(signal.timestamp_millis)} {signal.host} auditd "
        f"{procid} {signal.rule_id} [event@32473 {structured}] {_safe_text(signal.message)}"
    )


def render_rfc3164(signal: NativeSignal) -> str:
    """Render a traditional BSD syslog record (RFC 3164, bounded to 1024 bytes)."""
    dt = datetime.fromtimestamp(signal.timestamp_millis / 1000.0, tz=timezone.utc)
    timestamp = f"{dt.strftime('%b')} {dt.day:2d} {dt.strftime('%H:%M:%S')}"
    procid = _stable_int(signal.native_id, minimum=1000, span=8000)
    pri = 10 * 8 + 6  # authpriv.info
    msg = (
        f"Accepted publickey for {signal.user} from {signal.source_ip} port 22 ssh2; "
        f"host={signal.host} outcome={signal.outcome}"
    )
    return f"<{pri}>{timestamp} {signal.host} sshd[{procid}]: {_safe_text(msg)}"[:1024]


def render_entra_signin(signal: NativeSignal) -> str:
    """Render a Microsoft Graph ``auditLogs/signIns``-shaped record.

    The payload is offline synthetic data but keeps Entra's native field vocabulary
    (risk levels/state/detail, Conditional Access status, status/errorCode, device and
    location objects). ``_demo`` is a bounded extension used only to map the normalized
    0..100 severity and deterministic rule identity through the generic receiver.
    """
    risky = signal.native_alert or signal.severity >= 70
    obj = {
        "id": signal.native_id,
        "createdDateTime": _iso_millis(signal.timestamp_millis),
        "userDisplayName": signal.user.split("@")[0].replace(".", " ").title(),
        "userPrincipalName": (
            signal.user if "@" in signal.user else f"{signal.user}@lumenpay.example"
        ),
        "userId": stable_signature("demo-entra-user", signal.user),
        "ipAddress": signal.source_ip,
        "appDisplayName": "LumenPay Borrower Operations",
        "resourceDisplayName": "Microsoft Graph",
        # Plain-text rendering fallback for the unified log browser. The canonical
        # Entra status/risk fields remain present below; this bounded extension keeps
        # the common source browser useful without source-specific UI branching.
        "message": signal.message,
        "clientAppUsed": "Browser",
        "authenticationRequirement": "multiFactorAuthentication",
        "conditionalAccessStatus": "failure" if risky else "success",
        "isInteractive": True,
        "riskDetail": "adminConfirmedCompromised" if risky else "none",
        "riskLevelAggregated": "high" if risky else "none",
        "riskLevelDuringSignIn": "high" if risky else "none",
        "riskState": "atRisk" if risky else "none",
        "status": {
            "errorCode": 53003 if risky and signal.outcome == "blocked" else 0,
            "failureReason": "Blocked by Conditional Access" if signal.outcome == "blocked" else "",
            "additionalDetails": "MFA requirement satisfied" if signal.outcome == "success" else "",
        },
        "deviceDetail": {
            "deviceId": stable_signature("demo-entra-device", signal.host),
            "displayName": signal.host,
            "operatingSystem": "Windows 11",
            "browser": "Edge 126",
            "isCompliant": not risky,
            "isManaged": True,
            "trustType": "Microsoft Entra joined",
        },
        "location": {
            "city": "Mumbai" if not risky else "Documentation Range",
            "countryOrRegion": "IN" if not risky else "ZZ",
            "geoCoordinates": {"latitude": None, "longitude": None},
        },
        "appliedConditionalAccessPolicies": [{
            "displayName": "Require MFA for SOC-sensitive applications",
            "enforcedGrantControls": ["Mfa"],
            "result": "failure" if risky else "success",
        }],
        "_demo": {
            "severity": signal.severity,
            "rule_id": signal.rule_id,
            "rule_name": signal.rule_name,
            "message": signal.message,
            "action": signal.action,
            "outcome": signal.outcome,
            "story_id": signal.story_id,
            "mitre_technique_id": list(signal.techniques),
        },
    }
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


class _SplunkDemoReceiver(HECReceiver):
    source_type = SourceType.SPLUNK


class _QRadarDemoReceiver(WebhookReceiver):
    source_type = SourceType.QRADAR


class _WazuhDemoReceiver(WebhookReceiver):
    source_type = SourceType.WAZUH


class _EntraDemoReceiver(WebhookReceiver):
    source_type = SourceType.SENTINEL


class NativeDemoSource:
    """Offline source adapter: native wire payload -> production parser -> RawEvent."""

    _RECENT_MAX = 500

    def __init__(self, key: str, *, seed: int = 1337) -> None:
        if key not in DEMO_SOURCE_SPECS:
            raise ValueError(f"unknown demo source: {key}")
        self.spec = DEMO_SOURCE_SPECS[key]
        self.connector_id = self.spec.source_id
        self.source_type = self.spec.source_type
        self._seed = int(seed)
        self._org = gen.build_org(seed)
        self._recent: deque[RawEvent] = deque(maxlen=self._RECENT_MAX)
        self._events_total = 0
        self._alerts_total = 0
        self._system_detections_total = 0
        self._last_payload = ""
        self._last_event_millis = 0

        common = {
            "auth_mode": "none",
            "field_mappings_extra": {
                "source_ip_field": "src_ip",
                "user_field": "user",
                "host_field": "dest_host",
                "message_field": "message",
                "severity_field": "severity",
                "rule_field": "rule_id",
                "rule_name_field": "rule_name",
                "time_field": "timestamp",
            },
        }
        self._splunk = _SplunkDemoReceiver(common, connector_id=self.connector_id)
        self._qradar_leef = _QRadarDemoReceiver({
            "auth_mode": "none",
            "format_hint": "leef",
            "field_mappings_extra": {
                "source_ip_field": "source_ip",
                "user_field": "username",
                "host_field": "devName",
                "message_field": "message",
                # Preserve QRadar's native 1..10 `sev` in raw_data, but normalize through
                # the parallel 0..100 value so OCSF severity is honest (a demo source
                # cannot declare a ceiling — it never enters `Preferences.sources`).
                "severity_field": "demoSeverity",
                "rule_field": "event_id",
                "rule_name_field": "name",
                "time_field": "timestamp",
            },
        }, connector_id=self.connector_id)
        self._qradar_offense = _QRadarDemoReceiver({
            "auth_mode": "none",
            "format_hint": "json",
            "field_mappings_extra": {
                "source_ip_field": "offense_source",
                "user_field": "assigned_to",
                "host_field": "log_sources.0.name",
                "message_field": "description",
                # As above: native 1..10 `severity`/`magnitude` stay in raw_data, the
                # parallel 0..100 `_demo.severity` is what OCSF normalisation reads.
                "severity_field": "_demo.severity",
                "rule_field": "description",
                "rule_name_field": "description",
                "time_field": "last_updated_time",
            },
        }, connector_id=self.connector_id)
        self._wazuh_archive = _WazuhDemoReceiver({
            "auth_mode": "none",
            "format_hint": "json",
            "field_mappings_extra": {
                "source_ip_field": "data.srcip",
                "user_field": "data.srcuser",
                "host_field": "agent.name",
                "message_field": "full_log",
                "severity_field": "data.severity",
                "rule_field": "data.event_type",
                "rule_name_field": "data.event_name",
                "time_field": "timestamp",
            },
        }, connector_id=self.connector_id)
        self._wazuh_alert = _WazuhDemoReceiver({
            "auth_mode": "none",
            "format_hint": "json",
            "field_mappings_extra": {
                "source_ip_field": "data.srcip",
                "user_field": "data.srcuser",
                "host_field": "agent.name",
                "message_field": "full_log",
                # Preserve Wazuh's native 0..16 rule.level in raw_data, but normalize
                # through the parallel 0..100 decoded value so OCSF severity is honest.
                "severity_field": "data.severity",
                "rule_field": "rule.id",
                "rule_name_field": "rule.description",
                "time_field": "timestamp",
            },
        }, connector_id=self.connector_id)
        self._entra = _EntraDemoReceiver({
            "auth_mode": "none",
            "format_hint": "json",
            "field_mappings_extra": {
                "source_ip_field": "ipAddress",
                "user_field": "userPrincipalName",
                "host_field": "deviceDetail.displayName",
                "message_field": "message",
                "severity_field": "_demo.severity",
                "rule_field": "_demo.rule_id",
                "rule_name_field": "_demo.rule_name",
                "time_field": "createdDateTime",
            },
        }, connector_id=self.connector_id)
        self._syslog = SyslogReceiver({
            "format_hint": "auto",
            "field_mappings_extra": {
                "source_ip_field": "src",
                "user_field": "user",
                "host_field": "host",
                "message_field": "message",
                "severity_field": "demoSeverity",
                "rule_field": "rule",
                "rule_name_field": "eventName",
                "time_field": "timestamp",
            },
        }, connector_id=self.connector_id)

    def _parse(self, payload: str, prefs: Preferences, *, native_alert: bool) -> list[RawEvent]:
        body = payload.encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.spec.key == "splunk":
            events = self._splunk.handle_request(body, headers, prefs)
        elif self.spec.key == "qradar":
            receiver = self._qradar_offense if native_alert else self._qradar_leef
            headers = {"Content-Type": "application/json" if native_alert else "text/plain"}
            events = receiver.handle_request(body, headers, prefs)
        elif self.spec.key == "wazuh":
            receiver = self._wazuh_alert if native_alert else self._wazuh_archive
            events = receiver.handle_request(body, headers, prefs)
        elif self.spec.key == "entra":
            events = self._entra.handle_request(body, headers, prefs)
        else:
            events = self._syslog.parse(body, prefs)

        for event in events:
            event.source_id = self.spec.source_id
            event.source_name = self.spec.display_name
            # The simulated transport is push, but index is still a useful stable
            # identity namespace for source-qualified event IDs and case evidence.
            event.index = f"demo-{self.spec.key}-native"
            # The payload has already crossed the production parser.  Retain the exact
            # standards-shaped wire evidence for Logs/case reproduction without
            # replacing parsed fields.  It is untrusted source data and bounded here.
            event.source["_demo_native"] = {
                "wire_format": self.spec.wire_format,
                "payload": payload[:16_384],
            }
            if native_alert:
                event.index_role = "alerts"
        return events

    def emit_signal(self, signal: NativeSignal, prefs: Preferences) -> NativeEmission:
        """Render and parse one signal, retaining it in the bounded browse ring."""
        if self.spec.key == "splunk":
            payload = render_splunk_hec(signal)
        elif self.spec.key == "qradar":
            payload = render_qradar_offense(signal) if signal.native_alert else render_qradar_leef(signal)
        elif self.spec.key == "wazuh":
            payload = render_wazuh_alert(signal) if signal.native_alert else render_wazuh_archive(signal)
        elif self.spec.key == "entra":
            payload = render_entra_signin(signal)
        else:
            try:
                ordinal = int(signal.native_id.rsplit("-", 1)[-1])
            except (TypeError, ValueError):
                ordinal = 1
            # A quarter of benign messages use legacy BSD syslog; incident bursts stay
            # RFC 5424 so their structured entity fields reach deterministic detection.
            use_3164 = not signal.story_id and ordinal % 4 == 0
            payload = render_rfc3164(signal) if use_3164 else render_rfc5424(signal)

        # Syslog is raw telemetry even during a coordinated incident; Agentic SOC's own
        # correlation/funnel raises the detection.  Never call it a vendor-native alert.
        is_native_alert = signal.native_alert and self.spec.key != "syslog"
        events = self._parse(payload, prefs, native_alert=is_native_alert)
        for event in events:
            # The production parser is authoritative.  A few source-native time fields
            # (notably QRadar epoch-string variants) may be legal for the vendor but not
            # understood by a generic ISO parser; the emission clock is an exact,
            # truthful fallback so health/correlation never report epoch zero.
            if not event.timestamp_millis:
                event.timestamp_millis = signal.timestamp_millis
        self._last_payload = payload
        self._recent.extend(events)
        self._events_total += len(events)
        self._alerts_total += len(events) if is_native_alert else 0
        if events:
            self._last_event_millis = max(
                self._last_event_millis,
                max(int(event.timestamp_millis or 0) for event in events),
            )
        return NativeEmission(
            source_key=self.spec.key,
            source_id=self.spec.source_id,
            wire_format=self.spec.wire_format,
            payload=payload,
            events=tuple(events),
            native_alert=is_native_alert,
            story_id=signal.story_id,
        )

    def record_system_detections(self, count: int) -> None:
        """Record detections Agentic SOC raised from this source's raw telemetry."""
        self._system_detections_total += max(0, int(count))

    def _benign_signal(self, rng: random.Random, ts_millis: int, ordinal: int) -> NativeSignal:
        host_pools = {
            "splunk": [h for h in self._org.hosts if h.segment in ("siem", "xdr")],
            "qradar": [h for h in self._org.hosts if h.segment in ("siem", "xdr")],
            "wazuh": [h for h in self._org.hosts if h.segment == "edr"],
            "syslog": [h for h in self._org.hosts if h.segment == "xdr"],
            "entra": list(self._org.hosts),
        }
        hosts = host_pools[self.spec.key] or list(self._org.hosts)
        host = hosts[rng.randrange(len(hosts))]
        employee = self._org.employees[rng.randrange(len(self._org.employees))]
        source_ip = f"10.20.{20 + rng.randrange(20)}.{2 + rng.randrange(248)}"
        rules = {
            "splunk": ("web_access", "Successful portal API request", "request"),
            "qradar": ("LP-QR-0001", "Allowed application flow", "allow"),
            "wazuh": ("osquery_process_event", "Expected signed process start", "process_start"),
            "syslog": ("SSHD-SESSION", "SSH session accepted", "authentication"),
            "entra": ("Entra sign-in", "Successful interactive sign-in", "authentication"),
        }
        rule_id, rule_name, action = rules[self.spec.key]
        native_id = f"{self.spec.source_id}-{ts_millis}-{ordinal:04d}"
        return NativeSignal(
            native_id=native_id,
            timestamp_millis=ts_millis,
            source_ip=source_ip,
            user=employee.user,
            host=host.name,
            action=action,
            outcome="success",
            # Stay on an unambiguous 0..100 scale: generic OCSF mapping intentionally
            # treats values <=10 as a native 0..10 SIEM ladder.
            severity=round(15.0 + rng.random() * 15.0, 1),
            rule_id=rule_id,
            rule_name=rule_name,
            message=f"{rule_name}: {employee.user} on {host.name} from {source_ip}",
        )

    def benign_batch_raw(
        self,
        rng: random.Random,
        ts_millis: int,
        count: int,
        prefs: Preferences,
    ) -> list[RawEvent]:
        out: list[RawEvent] = []
        for ordinal in range(max(0, int(count))):
            signal = self._benign_signal(rng, ts_millis + ordinal, ordinal)
            out.extend(self.emit_signal(signal, prefs).events)
        return out

    def _story_signal(
        self,
        story: gen.Storyline,
        start_millis: int,
        ordinal: int = 0,
    ) -> NativeSignal:
        # All public indicators are RFC 5737 documentation ranges.  Demo Mode must
        # never teach a presenter to investigate/contact live third-party addresses.
        subjects = {
            "phishing_chain": ("203.0.113.77", "pnair", "web-api", "login", "success", 91.0),
            "rdp_bruteforce": ("198.51.100.42", "admin0", "jumpbox01", "login", "failure", 86.0),
            "sqli_webshell": ("192.0.2.90", "svc_bureau", "web-api", "upload", "success", 90.0),
            "impossible_travel": ("203.0.113.190", "rmenon", "vpn01", "login", "success", 74.0),
            "ransomware_beacon": ("198.51.100.77", "svc_bureau", "appsrv02", "file_modify", "success", 96.0),
            "insider_staging": ("10.20.6.12", "akulkarni", "bureau-gw", "download", "success", 76.0),
        }
        ip, user, host, action, outcome, severity = subjects.get(
            story.id, ("203.0.113.77", "pnair", "web-api", "alert", "success", 85.0)
        )
        native_rule = gen.NATIVE_STORY_RULE_IDS[self.spec.key][story.id]
        # QRadar offense descriptions are the normalized rule identity.  Other sources
        # carry a source-native rule id and keep the human title separate.
        rule_name = story.name
        message = f"{story.name}: correlated activity for {user} from {ip} on {host}"
        return NativeSignal(
            native_id=f"{self.spec.source_id}-incident-{start_millis}-{ordinal:02d}",
            timestamp_millis=start_millis + ordinal * 1000,
            source_ip=ip,
            user=user,
            host=host,
            action=action,
            outcome=outcome,
            severity=severity,
            rule_id=native_rule,
            rule_name=rule_name,
            message=message,
            native_alert=self.spec.key != "syslog",
            story_id=story.id,
            techniques=tuple(story.techniques),
        )

    def storyline_raw(
        self,
        story: gen.Storyline,
        rng: random.Random,
        start_millis: int,
        prefs: Preferences,
    ) -> list[RawEvent]:
        """One source's contribution to a coherent incident.

        Splunk/QRadar/Wazuh/Entra each produce one native detection. Syslog produces a
        four-event raw burst with the same entity/rule; the demo event funnel detects
        that threshold and creates Agentic SOC's own alert.
        """
        del rng  # scenario facts are intentionally stable; ordering supplies variance.
        count = 4 if self.spec.key == "syslog" else 1
        out: list[RawEvent] = []
        for ordinal in range(count):
            out.extend(self.emit_signal(
                self._story_signal(story, start_millis, ordinal), prefs
            ).events)
        return out

    def native_alert_raw(
        self,
        rng: random.Random,
        start_millis: int,
        prefs: Preferences,
    ) -> list[RawEvent]:
        """A low-confidence source-native alert (never used for raw syslog)."""
        if self.spec.key == "syslog":
            return []
        rule_id, rule_name = _NATIVE_ALERT_RULES[self.spec.key]
        host = self._org.hosts[rng.randrange(len(self._org.hosts))]
        ip = "198.51.100.23"
        signal = NativeSignal(
            native_id=f"{self.spec.source_id}-native-alert-{start_millis}",
            timestamp_millis=start_millis,
            source_ip=ip,
            user="scanner_service",
            host=host.name,
            action="scan",
            outcome="blocked",
            severity=58.0,
            rule_id=rule_id,
            rule_name=rule_name,
            message=f"{rule_name}: activity from {ip} was blocked",
            native_alert=True,
        )
        return list(self.emit_signal(signal, prefs).events)

    def prime(self, prefs: Preferences, *, now_millis: int, count: int = 12) -> None:
        """Populate browse/health immediately without creating cases or spending."""
        rng = random.Random(self._seed ^ _stable_int(self.spec.key))
        count = max(1, int(count))
        start = now_millis - count * 5_000
        # ``benign_batch_raw`` deliberately spaces high-throughput events by one
        # millisecond. Priming represents an already-running source instead, so emit
        # one sample every five seconds and finish at ``now``; a freshly enabled live
        # source must never announce itself as silent on its first health read.
        for ordinal in range(count):
            signal = self._benign_signal(
                rng, start + (ordinal + 1) * 5_000, ordinal,
            )
            self.emit_signal(signal, prefs)

    async def ping(self) -> bool:
        return True

    async def poll(self, prefs: Preferences, cursor: Cursor, from_millis: int) -> list[RawEvent]:
        del cursor, from_millis
        return list(self._recent)

    async def search(self, prefs: Preferences, query: StructuredQuery) -> SearchResult:
        del prefs
        events = list(self._recent)
        bound_now = now_utc()
        if query.time_from:
            floor = relative_to_millis(query.time_from, now=bound_now)
            events = [event for event in events if event.timestamp_millis >= floor]
        if query.time_to:
            ceiling = relative_to_millis(query.time_to, now=bound_now)
            events = [event for event in events if event.timestamp_millis <= ceiling]
        if query.ids:
            wanted = {str(value) for value in query.ids}
            events = [event for event in events if str(event.id) in wanted]
        if query.ip is not None:
            events = [event for event in events if event.ip == query.ip]
        if query.user is not None:
            events = [event for event in events if event.user == query.user]
        if query.host is not None:
            events = [event for event in events if event.host == query.host]
        if query.rule is not None:
            events = [
                event for event in events
                if event.rule == query.rule or event.rule_name == query.rule
            ]
        if query.severity_gte is not None:
            floor = float(query.severity_gte)
            events = [event for event in events if float(event.severity or 0.0) >= floor]
        if query.contains:
            needle = str(query.contains).lower()
            events = [
                event for event in events
                if needle in json.dumps(event.source, sort_keys=True, default=str).lower()
            ]
        events.sort(key=lambda event: event.timestamp_millis, reverse=bool(query.sort_desc))
        total = len(events)
        size = max(1, min(int(query.size or 50), 200))
        events = events[:size]
        return SearchResult(
            events=events,
            total=total,
            rendering=QueryRendering(
                query=json.dumps(
                    query.model_dump(exclude_none=True), sort_keys=True, default=str,
                ),
                language="native-demo",
                data_view=self.spec.wire_format,
            ),
        )

    async def fetch_by_ids(self, prefs: Preferences, ids: list[str], size: int) -> SearchResult:
        del prefs
        wanted = set(ids)
        events = [event for event in reversed(self._recent) if event.id in wanted][:max(1, size)]
        return SearchResult(events=events, total=len(events))

    async def test_connection(self, prefs: Preferences) -> ConnectionTest:
        del prefs
        return ConnectionTest(
            ok=True,
            message=f"Demo {self.spec.display_name}: offline native simulator ready.",
            mode="read_only",
        )

    def activity_snapshot(
        self,
        *,
        now_millis: int | None = None,
        mode: str = "live",
        running: bool = True,
        tick_seconds: float = 10.0,
    ) -> dict[str, Any]:
        """Serializable health/coverage row consumed by the demo API overlay."""
        now_millis = int(now_millis if now_millis is not None else to_millis(now_utc()))
        if self._recent:
            newest = max(int(event.timestamp_millis or 0) for event in self._recent)
            recent_minute = sum(
                1 for event in self._recent
                if int(event.timestamp_millis or 0) >= max(0, now_millis - 60_000)
            )
        else:
            newest = 0
            recent_minute = 0
        static = mode != "live"
        stale_after_ms = int(max(30.0, float(tick_seconds or 10.0) * 3.0) * 1000)
        silent = bool(
            not static and running and newest > 0 and now_millis - newest > stale_after_ms
        )
        healthy = bool(static or running)
        if static:
            state = "static"
        elif not running:
            state = "stopped"
        elif silent:
            state = "silent"
        else:
            state = "streaming" if self._events_total else "ready"
        row = self.spec.model_dump()
        row.update({
            "enabled": True,
            "healthy": healthy,
            "state": state,
            "buffer_depth": len(self._recent),
            "events_total": self._events_total,
            "alerts_total": self._alerts_total,
            "system_detections_total": self._system_detections_total,
            "last_event_millis": self._last_event_millis,
            "events_per_min": float(recent_minute if running and not static else 0),
            "silent": silent,
            "can_browse": True,
            "last_error": "live simulator is not running" if not healthy else None,
            "demo": True,
        })
        return row

    @property
    def last_payload(self) -> str:
        return self._last_payload


class DemoSourceMap(Mapping[str, NativeDemoSource]):
    """Five-source mapping with non-iterated aliases for legacy demo tests/routes."""

    def __init__(self, sources: dict[str, NativeDemoSource]) -> None:
        self._sources = dict(sources)

    def __getitem__(self, key: str) -> NativeDemoSource:
        return self._sources[LEGACY_SOURCE_ALIASES.get(key, key)]

    def __iter__(self) -> Iterator[str]:
        return iter(self._sources)

    def __len__(self) -> int:
        return len(self._sources)


def build_native_demo_sources(
    seed: int,
    prefs: Preferences,
    *,
    now_millis: int,
    prime_count: int = 12,
) -> DemoSourceMap:
    """Build and prime the isolated five-source collection."""
    sources = {
        key: NativeDemoSource(key, seed=seed)
        for key in DEMO_SOURCE_SPECS
    }
    for source in sources.values():
        source.prime(prefs, now_millis=now_millis, count=prime_count)
    return DemoSourceMap(sources)
