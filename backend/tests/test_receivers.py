"""Push/queue/object-store receivers — fully offline, no optional deps, no sockets.

Proves the ingestion framework supports every common forward/subscribe transport:
  1. Format detection + parsing for json/ndjson/CEF/LEEF/syslog-3164/syslog-5424/
     GELF/kv on realistic sample lines (asserts extracted fields).
  2. ``WebhookReceiver.handle_request`` with bearer + HMAC auth (valid + invalid)
     and JSON + NDJSON bodies → asserts RawEvents are normalised (ip/user/severity
     surface from generic_to_ocsf).
  3. ``HECReceiver`` unwraps the Splunk HEC ``event`` envelope.
  4. ``SyslogReceiver.parse`` on a raw syslog line → RawEvent.
  5. EVERY class in ``BUILTIN_RECEIVERS`` returns a valid ``manifest()`` with a
     non-empty ``ingest_modes`` WITHOUT importing any optional dep (so the wizard
     can list them, and the suite stays green with nothing extra installed).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import ssl

import pytest

from app.config import Preferences, SourceInstance
from app.constants import IngestMode, SourceType
from app.connectors.base import ConnectorManifest, PushReceiver
from app.connectors.receivers import (
    BUILTIN_RECEIVERS,
    HECReceiver,
    S3Receiver,
    SyslogReceiver,
    WebhookReceiver,
    detect_format,
    records_from_payload,
)
from app.engine.ingest import dedup_by_id, ensure_push_event_ids
from app.models import RawEvent
from app.connectors.receivers.formats import (
    parse_cef,
    parse_gelf,
    parse_kv,
    parse_leef,
    parse_ndjson,
    parse_syslog_rfc3164,
    parse_syslog_rfc5424,
)


@pytest.fixture
def prefs() -> Preferences:
    return Preferences()


# --------------------------------------------------------------------------- #
# 1. Format detection
# --------------------------------------------------------------------------- #
def test_detect_format():
    assert detect_format('{"a": 1}') == "json"
    assert detect_format('{"a":1}\n{"a":2}') == "ndjson"
    assert detect_format(
        'CEF:0|Vendor|Product|1.0|100|name|7|src=1.2.3.4'
    ) == "cef"
    assert detect_format("LEEF:1.0|IBM|QRadar|1.0|41|src=1.2.3.4") == "leef"
    assert detect_format("<165>1 2003-10-11T22:14:15Z host app - - - msg") == "syslog5424"
    assert detect_format("<34>Oct 11 22:14:15 host su: failed") == "syslog3164"
    assert detect_format(
        '{"version":"1.1","host":"h","short_message":"m"}'
    ) == "gelf"
    assert detect_format("level=error src_ip=1.2.3.4 user=root") == "kv"
    assert detect_format("just some free text") == "raw"
    assert detect_format("") == "raw"
    # A leading-syslog-wrapped CEF is still detected as CEF (search anywhere).
    assert detect_format("<13>Jun 20 10:00:00 host CEF:0|V|P|1|1|n|5|src=1.1.1.1") == "cef"


# --------------------------------------------------------------------------- #
# 1. JSON / NDJSON
# --------------------------------------------------------------------------- #
def test_parse_json_object_and_array():
    recs = records_from_payload('{"a": 1, "b": "x"}')
    assert recs == [{"a": 1, "b": "x"}]
    recs = records_from_payload('[{"a": 1}, {"a": 2}]')
    assert len(recs) == 2 and recs[1]["a"] == 2


def test_parse_ndjson():
    recs = parse_ndjson('{"a":1}\n\n{"a":2}\n')
    assert [r["a"] for r in recs] == [1, 2]


def test_parse_ndjson_bad_line_is_best_effort_not_dropped():
    recs = parse_ndjson('{"a":1}\nnot json\n{"a":2}')
    assert len(recs) == 3
    assert recs[1]["message"] == "not json"
    assert "_parse_error" in recs[1]
    # The good lines around the bad one still parse.
    assert recs[0]["a"] == 1 and recs[2]["a"] == 2


def test_malformed_json_never_raises():
    recs = records_from_payload("{not valid", hint="json")
    assert len(recs) == 1
    assert "_parse_error" in recs[0]


# --------------------------------------------------------------------------- #
# 1. CEF
# --------------------------------------------------------------------------- #
def test_parse_cef_arcsight_sample():
    line = (
        "CEF:0|Security|threatmanager|1.0|100|worm successfully stopped|10|"
        "src=10.0.0.1 dst=2.1.2.2 spt=1232 suser=alice msg=worm detected"
    )
    rec = parse_cef(line)[0]
    assert rec["cef_version"] == "0"
    assert rec["vendor"] == "Security"
    assert rec["product"] == "threatmanager"
    assert rec["signature_id"] == "100"
    assert rec["name"] == "worm successfully stopped"
    assert rec["severity"] == "10"
    assert rec["src"] == "10.0.0.1"
    assert rec["source_ip"] == "10.0.0.1"          # friendly alias
    assert rec["dest_ip"] == "2.1.2.2"
    assert rec["source_port"] == "1232"
    assert rec["username"] == "alice"
    assert rec["message"] == "worm detected"        # msg alias, value with a space


def test_parse_cef_escaped_pipe_and_equals():
    line = r"CEF:0|Ven\|dor|Prod|1|7|na\|me|5|src=1.2.3.4 cs1=a\=b"
    rec = parse_cef(line)[0]
    assert rec["vendor"] == "Ven|dor"
    assert rec["name"] == "na|me"
    assert rec["cs1"] == "a=b"


def test_parse_cef_with_syslog_prefix():
    line = "<13>Jun 20 10:00:00 fw CEF:0|V|P|1|1|alert|5|src=8.8.8.8"
    rec = parse_cef(line)[0]
    assert rec["vendor"] == "V"
    assert rec["source_ip"] == "8.8.8.8"


# --------------------------------------------------------------------------- #
# 1. LEEF
# --------------------------------------------------------------------------- #
def test_parse_leef_v1_tab_delimited():
    line = "LEEF:1.0|Lancope|StealthWatch|1.0|41|src=192.0.2.0\tdst=172.50.123.1\tsev=5\tusrName=joe"
    rec = parse_leef(line)[0]
    assert rec["leef_version"] == "1.0"
    assert rec["vendor"] == "Lancope"
    assert rec["event_id"] == "41"
    assert rec["src"] == "192.0.2.0"
    assert rec["source_ip"] == "192.0.2.0"
    assert rec["dest_ip"] == "172.50.123.1"
    assert rec["severity"] == "5"
    assert rec["username"] == "joe"


def test_parse_leef_v2_custom_delimiter():
    # LEEF 2.0 declares a custom delimiter (^) in the 6th header field.
    line = "LEEF:2.0|IBM|QRadar|3.0|99|^|src=10.1.1.1^dst=10.2.2.2^usrName=bob"
    rec = parse_leef(line)[0]
    assert rec["leef_version"] == "2.0"
    assert rec["source_ip"] == "10.1.1.1"
    assert rec["dest_ip"] == "10.2.2.2"
    assert rec["username"] == "bob"


# --------------------------------------------------------------------------- #
# 1. Syslog RFC 5424
# --------------------------------------------------------------------------- #
def test_parse_syslog_rfc5424_full():
    line = (
        '<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 '
        '[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"] '
        "BOM An application event log entry"
    )
    rec = parse_syslog_rfc5424(line)[0]
    assert rec["pri"] == 165
    assert rec["facility"] == 20
    assert rec["severity"] == 5
    assert rec["severity_score"] == 25.0
    assert rec["severity_label"] == "notice"
    assert rec["version"] == "1"
    assert rec["host"] == "mymachine.example.com"
    assert rec["app"] == "evntslog"
    assert rec["procid"] is None        # the '-' NILVALUE
    assert rec["msgid"] == "ID47"
    assert rec["message"] == "BOM An application event log entry"
    # Structured data parsed + flattened.
    assert rec["structured_data"]["exampleSDID@32473"]["eventID"] == "1011"
    assert rec["iut"] == "3"


def test_parse_syslog_rfc5424_no_structured_data():
    line = "<34>1 2026-06-20T10:00:00Z host app 4711 - - simple message here"
    rec = parse_syslog_rfc5424(line)[0]
    assert rec["procid"] == "4711"
    assert rec["message"] == "simple message here"
    assert "structured_data" not in rec


# --------------------------------------------------------------------------- #
# 1. Syslog RFC 3164
# --------------------------------------------------------------------------- #
def test_parse_syslog_rfc3164_full():
    line = "<34>Oct 11 22:14:15 mymachine su[1234]: su root failed for lonvick on /dev/pts/8"
    rec = parse_syslog_rfc3164(line)[0]
    assert rec["pri"] == 34
    assert rec["facility"] == 4
    assert rec["severity"] == 2
    assert rec["host"] == "mymachine"
    assert rec["tag"] == "su"
    assert rec["procid"] == "1234"
    assert rec["message"] == "su root failed for lonvick on /dev/pts/8"


def test_parse_syslog_rfc3164_no_pid():
    line = "<13>Aug  5 09:00:00 router1 kernel: link down"
    rec = parse_syslog_rfc3164(line)[0]
    assert rec["host"] == "router1"
    assert rec["tag"] == "kernel"
    assert rec["message"] == "link down"


# --------------------------------------------------------------------------- #
# 1. GELF / kv
# --------------------------------------------------------------------------- #
def test_parse_gelf():
    line = json.dumps({
        "version": "1.1", "host": "web01", "short_message": "auth failure",
        "level": 3, "_src_ip": "203.0.113.5", "_user": "root",
    })
    rec = parse_gelf(line)[0]
    assert rec["message"] == "auth failure"      # short_message surfaced
    assert rec["src_ip"] == "203.0.113.5"        # underscore stripped for aliasing
    assert rec["user"] == "root"
    assert rec["_src_ip"] == "203.0.113.5"       # original preserved too


def test_parse_kv_logfmt():
    line = 'time=2026-06-20 level=error src_ip=198.51.100.7 user=admin msg="login failed"'
    rec = parse_kv(line)[0]
    assert rec["level"] == "error"
    assert rec["src_ip"] == "198.51.100.7"
    assert rec["user"] == "admin"
    assert rec["msg"] == "login failed"          # quoted value with a space


# --------------------------------------------------------------------------- #
# 2. WebhookReceiver — auth + normalisation
# --------------------------------------------------------------------------- #
def _json_body() -> bytes:
    return json.dumps({
        "source": {"ip": "203.0.113.9"},
        "user": {"name": "root"},
        "event": {"severity": 8},
        "@timestamp": "2026-06-20T10:00:00Z",
    }).encode()


def test_webhook_bearer_auth_valid(prefs):
    wh = WebhookReceiver(config={"auth_mode": "bearer", "token": "sekret"})
    events = wh.handle_request(
        _json_body(),
        {"Authorization": "Bearer sekret", "Content-Type": "application/json"},
        prefs,
    )
    assert len(events) == 1
    assert events[0].ip == "203.0.113.9"
    assert events[0].user == "root"
    # This receiver is not a CONFIGURED source, so no native ladder resolves and the raw
    # 8 projects through the identity -> severity_id 1 -> 10.0. The retired
    # ``raw <= 10 ? raw*10`` guess is what used to read it as High (75.0); it also
    # disagreed with a CONFIGURED push source, which already produced 10.0 here. See
    # ``test_undeclared_source_ingests_on_the_identity_ladder`` for the full contract.
    assert events[0].severity == 10.0


def test_webhook_bearer_auth_invalid(prefs):
    wh = WebhookReceiver(config={"auth_mode": "bearer", "token": "sekret"})
    with pytest.raises(PermissionError):
        wh.handle_request(_json_body(), {"Authorization": "Bearer wrong"}, prefs)
    # Missing header is also rejected.
    with pytest.raises(PermissionError):
        wh.handle_request(_json_body(), {}, prefs)


def test_webhook_hmac_auth_valid_and_invalid(prefs):
    secret = "shh"
    body = _json_body()
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    wh = WebhookReceiver(config={
        "auth_mode": "hmac", "shared_secret": secret, "signature_header": "X-Sig",
    })
    events = wh.handle_request(body, {"X-Sig": sig, "Content-Type": "application/json"}, prefs)
    assert len(events) == 1 and events[0].ip == "203.0.113.9"
    # Tolerate a "sha256=" prefixed signature.
    events2 = wh.handle_request(body, {"X-Sig": f"sha256={sig}"}, prefs)
    assert len(events2) == 1
    with pytest.raises(PermissionError):
        wh.handle_request(body, {"X-Sig": "deadbeef"}, prefs)


def test_webhook_auth_none(prefs):
    wh = WebhookReceiver(config={"auth_mode": "none"})
    events = wh.handle_request(_json_body(), {}, prefs)
    assert len(events) == 1


def test_webhook_ndjson_body(prefs):
    wh = WebhookReceiver(config={"auth_mode": "none"})
    nd = (
        json.dumps({"src_ip": "10.0.0.1", "username": "a", "severity": 9})
        + "\n"
        + json.dumps({"src_ip": "10.0.0.2", "username": "b", "severity": 2})
    ).encode()
    events = wh.handle_request(nd, {"Content-Type": "application/x-ndjson"}, prefs)
    assert len(events) == 2
    assert [e.ip for e in events] == ["10.0.0.1", "10.0.0.2"]
    assert events[0].user == "a"
    # Undeclared ladder -> identity: 9/100 -> severity_id 1 -> 10.0 (see the dedicated
    # ingest-ladder contract test below).
    assert events[0].severity == 10.0


def test_idless_ndjson_ids_are_distinct_stable_and_source_scoped(prefs):
    """ID-less records cannot collapse at dedup; retrying one ordered payload is stable."""
    body = (
        json.dumps({"src_ip": "10.0.0.1", "message": "same"})
        + "\n"
        + json.dumps({"src_ip": "10.0.0.1", "message": "same"})
        + "\n"
        + json.dumps({"src_ip": "10.0.0.2", "message": "other"})
    ).encode()
    headers = {"Content-Type": "application/x-ndjson"}
    source_a = WebhookReceiver(config={"auth_mode": "none"}, connector_id="source-a")
    first = source_a.handle_request(body, headers, prefs)
    retry = source_a.handle_request(body, headers, prefs)

    ids = [event.id for event in first]
    assert all(ids)
    assert len(ids) == len(set(ids)) == 3
    assert [event.id for event in retry] == ids
    assert len(dedup_by_id(first)) == 3

    source_b = WebhookReceiver(config={"auth_mode": "none"}, connector_id="source-b")
    assert set(ids).isdisjoint(event.id for event in source_b.handle_request(body, headers, prefs))


def test_identical_vendor_ids_are_isolated_at_ingest_boundary():
    """Custom receivers cannot make two source instances collide on a vendor id."""
    events = [
        RawEvent(id="vendor-41", source_id="source-a", source={"id": "vendor-41"}),
        RawEvent(id="vendor-41", source_id="source-b", source={"id": "vendor-41"}),
    ]
    ensure_push_event_ids(events)
    assert events[0].id != events[1].id
    assert len(dedup_by_id(events)) == 2


def test_webhook_applies_saved_source_field_mappings(prefs):
    # The saved source config carries the field mappings AND the source's declared
    # native severity ceiling — both are read from the same configured SourceInstance.
    prefs = prefs.model_copy(update={"sources": [SourceInstance(
        id="custom-webhook",
        source_type=SourceType.GENERIC,
        ingest_mode=IngestMode.PUSH_HTTP,
        display_name="Custom webhook on a 0-10 risk ladder",
        severity_scale_max=10.0,
    )]})
    wh = WebhookReceiver(
        config={
            "auth_mode": "none",
            "source_ip_field": "wrong.ip",
            "field_mappings_extra": {
                "source_ip_field": "vendor.client.address",
                "user_field": "vendor.identity.account",
                "host_field": "vendor.asset.hostname",
                "rule_field": "vendor.detection.code",
                "rule_name_field": "vendor.detection.title",
                "severity_field": "vendor.risk.value",
                "time_field": "vendor.observed_at",
            },
        },
        connector_id="custom-webhook",
    )
    body = json.dumps({
        "vendor": {
            "client": {"address": "203.0.113.44"},
            "identity": {"account": "alice"},
            "asset": {"hostname": "workstation-7"},
            "detection": {"code": "DET-7", "title": "Impossible travel"},
            "risk": {"value": 9},
            "observed_at": "2026-07-11T12:00:00Z",
        }
    }).encode()
    event = wh.handle_request(body, {"Content-Type": "application/json"}, prefs)[0]
    assert event.ip == "203.0.113.44"
    assert event.user == "alice"
    assert event.host == "workstation-7"
    assert event.rule == "DET-7"
    assert event.rule_name == "Impossible travel"
    # risk.value 9 on the source's DECLARED 0-10 ladder -> 90/100 -> severity_id 5 -> 90.0
    assert event.severity == 90.0
    assert event.timestamp_millis > 0


def test_webhook_cef_body(prefs):
    wh = WebhookReceiver(config={"auth_mode": "none", "format_hint": "cef"})
    body = b"CEF:0|V|P|1|100|alert|7|src=203.0.113.77 suser=svc"
    events = wh.handle_request(body, {}, prefs)
    assert len(events) == 1
    assert events[0].ip == "203.0.113.77"
    assert events[0].user == "svc"


# --------------------------------------------------------------------------- #
# 3. HECReceiver — unwrap the Splunk envelope
# --------------------------------------------------------------------------- #
def test_hec_unwraps_object_event(prefs):
    hec = HECReceiver(config={"auth_mode": "none"})
    body = json.dumps({
        "event": {"src_ip": "198.51.100.4", "username": "svc", "severity": 9},
        "fields": {"host": "h1"},
        "time": 1700000000,
        "host": "h1",
    }).encode()
    events = hec.handle_request(body, {}, prefs)
    assert len(events) == 1
    assert events[0].ip == "198.51.100.4"
    assert events[0].user == "svc"
    # Undeclared ladder -> identity (see the ingest-ladder contract test below).
    assert events[0].severity == 10.0


def test_hec_unwraps_string_event(prefs):
    hec = HECReceiver(config={"auth_mode": "none"})
    body = json.dumps({"event": "a raw syslog-ish line", "sourcetype": "syslog"}).encode()
    events = hec.handle_request(body, {}, prefs)
    assert len(events) == 1


def test_hec_splunk_authorization_header(prefs):
    hec = HECReceiver(config={"auth_mode": "bearer", "token": "hectoken"})
    body = json.dumps({"event": {"src_ip": "1.2.3.4"}}).encode()
    # HEC senders use "Authorization: Splunk <token>".
    events = hec.handle_request(body, {"Authorization": "Splunk hectoken"}, prefs)
    assert len(events) == 1 and events[0].ip == "1.2.3.4"


def test_hec_batched_newline_delimited(prefs):
    hec = HECReceiver(config={"auth_mode": "none"})
    body = (
        json.dumps({"event": {"src_ip": "10.0.0.1"}})
        + "\n"
        + json.dumps({"event": {"src_ip": "10.0.0.2"}})
    ).encode()
    events = hec.handle_request(body, {}, prefs)
    assert [e.ip for e in events] == ["10.0.0.1", "10.0.0.2"]


# --------------------------------------------------------------------------- #
# 4. SyslogReceiver.parse — raw line → RawEvent
# --------------------------------------------------------------------------- #
def test_syslog_receiver_parse(prefs):
    sr = SyslogReceiver()
    line = "<34>Oct 11 22:14:15 web01 sshd[1234]: Failed password for root from 203.0.113.55 port 22"
    events = sr.parse(line, prefs)
    assert len(events) == 1
    assert events[0].host == "web01"
    assert "Failed password" in events[0].source.get("message", "")


def test_syslog_receiver_parse_5424(prefs):
    sr = SyslogReceiver()
    line = '<165>1 2026-06-20T22:14:15Z fw01 evntslog - ID47 - firewall deny event'
    events = sr.parse(line, prefs)
    assert len(events) == 1
    assert events[0].host == "fw01"


def test_syslog_idless_identity_is_stable_and_source_isolated(prefs):
    line = "<34>Oct 11 22:14:15 web01 sshd[1234]: Failed password for root"
    source_a = SyslogReceiver(connector_id="syslog-a")
    first = source_a.parse(line, prefs)[0]
    retry = source_a.parse(line, prefs)[0]
    source_b = SyslogReceiver(connector_id="syslog-b").parse(line, prefs)[0]
    assert first.id
    assert retry.id == first.id
    assert source_b.id != first.id


def test_syslog_tls_manifest_is_truthful_and_requires_mounted_material():
    manifest = SyslogReceiver.manifest()
    protocol = next(field for field in manifest.config_fields if field.key == "protocol")
    assert "tls" in (protocol.options or [])
    assert "planned" not in manifest.description.lower()
    assert {field.key for field in manifest.config_fields} >= {
        "tls_cert_file", "tls_key_file", "tls_client_ca_file", "tls_require_client_cert",
    }
    assert any(field.key == "tls_key_password" and field.secret for field in manifest.auth_fields)

    with pytest.raises(ValueError, match="certificate"):
        SyslogReceiver(config={"protocol": "tls"})._build_tls_context()


def test_syslog_tls_context_loads_cert_chain_and_optional_mtls(tmp_path, monkeypatch):
    cert = tmp_path / "server.crt"
    key = tmp_path / "server.key"
    ca = tmp_path / "clients.crt"
    cert.write_text("cert", encoding="utf-8")
    key.write_text("key", encoding="utf-8")
    ca.write_text("ca", encoding="utf-8")

    captured: dict[str, object] = {}

    class FakeContext:
        minimum_version = None
        verify_mode = None

        def __init__(self, protocol):
            captured["protocol"] = protocol

        def load_cert_chain(self, **kwargs):
            captured["chain"] = kwargs

        def load_verify_locations(self, **kwargs):
            captured["ca"] = kwargs

    monkeypatch.setattr(ssl, "SSLContext", FakeContext)
    receiver = SyslogReceiver(config={
        "protocol": "tls",
        "tls_cert_file": str(cert),
        "tls_key_file": str(key),
        "tls_key_password": "write-only",
        "tls_client_ca_file": str(ca),
        "tls_require_client_cert": "true",
    })

    context = receiver._build_tls_context()
    assert captured["protocol"] == ssl.PROTOCOL_TLS_SERVER
    assert captured["chain"] == {
        "certfile": str(cert), "keyfile": str(key), "password": "write-only",
    }
    assert captured["ca"] == {"cafile": str(ca)}
    assert context.minimum_version == ssl.TLSVersion.TLSv1_2
    assert context.verify_mode == ssl.CERT_REQUIRED


def test_syslog_mtls_requires_client_ca(tmp_path):
    cert = tmp_path / "server.crt"
    key = tmp_path / "server.key"
    cert.write_text("cert", encoding="utf-8")
    key.write_text("key", encoding="utf-8")
    receiver = SyslogReceiver(config={
        "protocol": "tls",
        "tls_cert_file": str(cert),
        "tls_key_file": str(key),
        "tls_require_client_cert": True,
    })
    with pytest.raises(ValueError, match="client_ca_file"):
        receiver._build_tls_context()


def test_score_to_severity_id_is_scale_aware():
    # audit #36: a genuine LOW 0..100 severity must NOT be magnitude-inflated. Only the
    # 0..10 / wazuh scales rescale; the 0..100 scale is identity.
    from app.ocsf.model import score_to_severity_id

    assert score_to_severity_id(8, "ocsf_0_100") == 1   # 8/100 → Informational (not High)
    assert score_to_severity_id(8, "0_10") == 4         # 8/10 → 80 → High
    assert score_to_severity_id(12, "wazuh_0_16") == 4  # 12/16*100 = 75 → High
    assert score_to_severity_id(8, "auto") == 4         # legacy heuristic unchanged (back-compat)
    assert score_to_severity_id(95, "ocsf_0_100") == 5  # Critical either way


def test_score_to_severity_id_accepts_a_declared_numeric_ceiling():
    """The modern input is a NUMBER — the source's declared ladder ceiling.

    One declared number describes any ladder (0-10, 0-16, 0-1000), projected through the
    ONE shared formula. The deprecated string ids above stay byte-identical, but nothing
    in the suite resolves a source to one of them any more."""
    from app.ocsf.model import score_to_severity_id

    assert score_to_severity_id(8, 100.0) == 1     # identity: 8/100 -> Informational
    assert score_to_severity_id(8, 10.0) == 4      # 8/10 -> 80 -> High
    assert score_to_severity_id(12, 16.0) == 4     # 12/16 -> 75 -> High
    assert score_to_severity_id(500, 1000.0) == 3  # 500/1000 -> 50 -> Medium
    # a ceiling that could never divide falls back rather than raising
    assert score_to_severity_id(8, 0) == score_to_severity_id(8, "auto")


def test_undeclared_source_ingests_on_the_identity_ladder(prefs):
    """INGEST-side contract: an UNDECLARED source projects raw severity through identity.

    A push receiver whose ``connector_id`` matches no configured source has no native
    ladder to resolve, so the raw number is read as-is on 0-100. The retired
    ``raw <= 10 ? raw*10`` guess used to inflate exactly this case — and it disagreed
    with a CONFIGURED push source, which already produced the identity reading, so this
    change removes an inconsistency rather than creating one.

    Declaring the source's real ceiling restores the high reading. That declaration is
    the ONLY thing that moves the number: the connector type is not an input.
    """
    body = json.dumps({"src_ip": "10.0.0.1", "severity": 9}).encode()
    headers = {"Content-Type": "application/json"}

    undeclared = WebhookReceiver(config={"auth_mode": "none"}, connector_id="wh-undeclared")
    ev = undeclared.handle_request(body, headers, prefs)[0]
    assert ev.severity == 10.0                       # 9/100 -> severity_id 1

    declared_prefs = prefs.model_copy(update={"sources": [SourceInstance(
        id="wh-declared",
        source_type=SourceType.GENERIC,
        ingest_mode=IngestMode.PUSH_HTTP,
        display_name="declared 0-10 ladder",
        severity_scale_max=10.0,
    )]})
    declared = WebhookReceiver(config={"auth_mode": "none"}, connector_id="wh-declared")
    ev2 = declared.handle_request(body, headers, declared_prefs)[0]
    assert ev2.severity == 90.0                      # 9/10 -> 90 -> severity_id 5

    # An unmatched connector_id against the SAME prefs falls back to the identity — the
    # two unresolvable paths (no sources at all / no matching source) never disagree.
    stray = WebhookReceiver(config={"auth_mode": "none"}, connector_id="wh-undeclared")
    assert stray.handle_request(body, headers, declared_prefs)[0].severity == 10.0


@pytest.mark.asyncio
async def test_syslog_udp_datagram_ingest_error_is_surfaced(prefs, caplog):
    # audit #35: a UDP datagram whose ingest FAILS must surface the error (and the task
    # must be retained until done), not be a swallowed fire-and-forget.
    import asyncio
    import logging

    from app.connectors.receivers.syslog import SyslogReceiver, _SyslogUDPProtocol

    async def failing_emit(events):
        raise RuntimeError("ingest down")

    # Make _emit_payload actually reach emit: a parseable line yields >=1 event.
    recv = SyslogReceiver(config={"format_hint": "syslog3164"}, connector_id="sl")
    proto = _SyslogUDPProtocol(recv, failing_emit, prefs)
    with caplog.at_level(logging.WARNING, logger="tlsoc.connectors.receivers.syslog"):
        proto.datagram_received(b"<34>Oct 11 22:14:15 host su: failure", ("127.0.0.1", 514))
        assert proto._tasks, "the ingest task must be retained (not GC-able)"
        # Let the scheduled task run + its done-callback fire.
        for _ in range(20):
            await asyncio.sleep(0)
            if not proto._tasks:
                break
    assert not proto._tasks, "completed task should be discarded from the retained set"
    assert any("ingest failed" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_mqtt_acks_only_after_successful_ingest(prefs, monkeypatch):
    # audit #18: MQTT must ack a message ONLY after a confirmed ingest; a failed ingest
    # is left UNACKED so the broker redelivers (at-least-once), never dropped.
    import asyncio
    import types

    from app.connectors.receivers import queues

    acked: list = []
    captured: dict = {}
    made: list = []

    class _FakeClient:
        def __init__(self, *a, **k):
            self.on_message = None
            self.on_connect = None
            made.append(self)

        def manual_ack_set(self, v):  # noqa: ANN001
            self._manual = v

        def username_pw_set(self, *a):  # noqa: ANN001
            pass

        def tls_set(self, *a):  # noqa: ANN001
            pass

        def connect(self, *a):  # noqa: ANN001
            pass

        def subscribe(self, *a, **k):  # noqa: ANN001
            pass

        def loop_start(self):
            pass

        def loop_stop(self):
            pass

        def disconnect(self):
            pass

        def ack(self, mid, qos):  # noqa: ANN001
            acked.append((mid, qos))

    fake_mod = types.SimpleNamespace(Client=lambda *a, **k: _FakeClient())
    monkeypatch.setattr(queues, "_require", lambda *a, **k: fake_mod)

    r = queues.MqttReceiver(config={"topic": "t", "format_hint": "json"}, connector_id="mq")
    fail = {"flag": False}

    async def emit(events):
        if fail["flag"]:
            raise RuntimeError("ingest down")

    task = asyncio.create_task(r.start(emit, prefs))
    try:
        for _ in range(50):
            await asyncio.sleep(0.01)
            if made and made[0].on_message:
                break
        client = made[0]
        on_msg = client.on_message
        loop = asyncio.get_running_loop()

        class _Msg:
            def __init__(self, payload, mid, qos=1):
                self.payload = payload
                self.mid = mid
                self.qos = qos

        # Success → acked. Drive on_message from a WORKER THREAD (as paho's network
        # thread would), so fut.result() blocks that thread, not the event loop.
        await loop.run_in_executor(None, on_msg, client, None, _Msg(b'{"message":"ok"}', 1))
        assert acked == [(1, 1)]

        # Failure → NOT acked (broker will redeliver).
        fail["flag"] = True
        await loop.run_in_executor(None, on_msg, client, None, _Msg(b'{"message":"bad"}', 2))
        assert acked == [(1, 1)], "a failed ingest must not be acked"
    finally:
        r._running = False
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


@pytest.mark.asyncio
async def test_object_store_marker_is_durable_across_restart(prefs):
    # audit #7: the last-processed object key must survive a restart via the injected
    # CursorStore IO — otherwise a restart re-lists from the configured start (a
    # re-processing storm) or (Kinesis) loses data.
    from app.models import Cursor

    saved: dict[str, dict] = {}

    async def _load() -> Cursor:
        return Cursor(**saved["v"]) if "v" in saved else Cursor()

    async def _save(cur: Cursor) -> None:
        saved["v"] = cur.model_dump()

    r = S3Receiver(config={"format_hint": "ndjson"}, connector_id="s3-dur")
    r.attach_cursor_io(load=_load, save=_save)
    emitted: list[RawEvent] = []

    async def emit(events: list[RawEvent]) -> None:
        emitted.extend(events)

    await r._emit_object("logs/2026/06/16/a.ndjson", b'{"message":"x"}\n', prefs, emit)
    assert emitted, "object should have emitted at least one event"
    assert saved["v"]["object_marker"] == "logs/2026/06/16/a.ndjson"

    # A fresh receiver (a restart) resumes from the persisted marker, not the config.
    r2 = S3Receiver(config={"format_hint": "ndjson"}, connector_id="s3-dur")
    r2.attach_cursor_io(load=_load, save=_save)
    await r2._restore_marker()
    assert r2._marker == "logs/2026/06/16/a.ndjson"


@pytest.mark.asyncio
async def test_push_receiver_without_cursor_io_is_noop(prefs):
    # No IO attached (unit tests / route-driven receivers) → load returns None, save is
    # a no-op; the receiver must not crash.
    r = S3Receiver(config={"format_hint": "ndjson"}, connector_id="s3-noio")
    assert await r.load_cursor() is None
    from app.models import Cursor

    await r.save_cursor(Cursor(object_marker="x"))  # no-op, must not raise


@pytest.mark.asyncio
async def test_object_store_emit_applies_saved_source_field_mappings(prefs):
    receiver = S3Receiver(
        config={
            "field_mappings_extra": {
                "source_ip_field": "custom.remote_ip",
                "user_field": "custom.principal",
                "rule_field": "custom.finding_id",
            }
        },
        connector_id="s3-source-a",
    )
    emitted: list[RawEvent] = []

    async def emit(events: list[RawEvent]) -> None:
        emitted.extend(events)

    payload = json.dumps({
        "custom": {
            "remote_ip": "198.51.100.8",
            "principal": "svc-backup",
            "finding_id": "S3-FINDING-1",
        }
    }).encode()
    count = await receiver._emit_payload_with_hint(payload, "json", prefs, emit)
    assert count == 1
    assert emitted[0].ip == "198.51.100.8"
    assert emitted[0].user == "svc-backup"
    assert emitted[0].rule == "S3-FINDING-1"
    assert emitted[0].id


# --------------------------------------------------------------------------- #
# 5. Every BUILTIN_RECEIVER has a valid manifest with NO optional deps imported
# --------------------------------------------------------------------------- #
def test_builtin_receivers_count():
    # Exactly the receivers the spec requires (16): webhook+hec, syslog,
    # 9 brokers, 3 object stores, file.
    assert len(BUILTIN_RECEIVERS) == 16


@pytest.mark.parametrize("cls", BUILTIN_RECEIVERS, ids=lambda c: c.__name__)
def test_receiver_manifest_valid(cls):
    assert issubclass(cls, PushReceiver)
    manifest = cls.manifest()
    assert isinstance(manifest, ConnectorManifest)
    # Non-empty ingest_modes so the wizard can list it.
    assert manifest.ingest_modes, f"{cls.__name__} has no ingest_modes"
    assert manifest.display_name
    assert manifest.source_type
    # Manifest must NOT require an instance or any credential.
    # Re-call to prove it is a pure classmethod (idempotent, side-effect free).
    assert cls.manifest().source_type == manifest.source_type


def test_receiver_source_types_are_unique():
    types = [c.manifest().source_type for c in BUILTIN_RECEIVERS]
    assert len(types) == len(set(types)), "duplicate source_type across receivers"


def test_broker_receivers_declare_pip_requirements():
    # The brokers/cloud receivers must declare their optional dep so the wizard
    # can surface "pip install ..." and the start() can fail clearly.
    from app.connectors.receivers import (
        AwsKinesisReceiver,
        AwsSqsReceiver,
        AzureBlobReceiver,
        AzureEventHubReceiver,
        GcpPubSubReceiver,
        GcsReceiver,
        KafkaReceiver,
        MqttReceiver,
        NatsReceiver,
        RabbitMqReceiver,
        RedisStreamsReceiver,
        S3Receiver,
    )

    need_dep = [
        KafkaReceiver, AwsSqsReceiver, AwsKinesisReceiver, AzureEventHubReceiver,
        GcpPubSubReceiver, RabbitMqReceiver, NatsReceiver, MqttReceiver,
        RedisStreamsReceiver, S3Receiver, GcsReceiver, AzureBlobReceiver,
    ]
    for cls in need_dep:
        assert cls.manifest().requires_pip, f"{cls.__name__} must declare requires_pip"

    # stdlib-only receivers must NOT require an optional dep.
    for cls in (WebhookReceiver, HECReceiver, SyslogReceiver):
        assert cls.manifest().requires_pip == []


def test_stdlib_receivers_importable_without_optional_deps():
    # Importing the package + calling manifest() must not pull in any optional
    # client lib. Assert the known-absent broker libs were NOT imported as a
    # side-effect of importing the receivers package.
    import sys

    for mod in ("confluent_kafka", "boto3", "azure", "google.cloud.pubsub_v1",
                "aio_pika", "nats", "paho"):
        assert mod not in sys.modules, f"{mod} should not be imported at manifest time"
