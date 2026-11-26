"""Investigate-flow coverage (Wave2): BUG-2 auto-widen, manual provenance, C3-4.

These exercise the /investigate + /cases/{id}/investigate routes over the full
app (fake ES + mock LLM), proving:

* BUG-2: a manual entity investigation auto-widens the lookback when the
  configured window is empty but a wider window has events, and returns a NEUTRAL
  400 when the entity is truly empty even at the widest rung.
* IMPROVEMENT: a manual investigate yields a Case with a non-null
  trigger_reason.sentence (so "Why this fired" renders), a persisted
  origin_surface, and a normalized reproduce_query (never a bare ``ip:``).
* C3-4: POST /cases/{id}/investigate re-runs an existing case (force), preserves
  origin_surface (an automated_scan case stays a scan), appends verdict_history,
  and 400s when no events remain.
"""

from __future__ import annotations

import json

from app.constants import SourceSurface
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event


def _seed(client, **kw) -> str:
    """Seed one log document into the running app's fake ES; return its id."""
    es = client.app.state.tlsoc.es
    src = make_log_event(**kw)
    return es.add_log("all-logs-2026.06.16", src)


def _ms_ago(days: float = 0.0, hours: float = 0.0) -> int:
    return to_millis(now_utc()) - int((days * 86400 + hours * 3600) * 1000)


def _final_verdict(verdict: str, confidence: float, reproduce_query: str) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted evidence", "event_ids": []}],
            "mitre": ["T1110"], "recommended_action": "block the source",
            "reproduce_query": reproduce_query,
        },
    })


def _route_to_investigator(mock_provider) -> None:
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}
    ))


# --------------------------------------------------------------------------- #
# TASK A — BUG-2: auto-widen ladder
# --------------------------------------------------------------------------- #
def test_investigate_auto_widens_to_find_old_events(client, mock_provider):
    ip = "10.130.171.185"
    # NOTHING in the last 24h/7d/30d; one event ~200 days ago (only now-365d catches it).
    _seed(client, ip=ip, ts_millis=_ms_ago(days=200))

    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.3, f"ip:{ip}"))

    r = client.post("/api/investigate", json={"entity": {"type": "ip", "value": ip}})
    # The case resolved (200, not the old generic 400) despite zero hits in the
    # configured now-24h window — the ladder widened out to now-365d.
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["entity"]["value"] == ip
    assert body["reproduce_query"] == f'source.ip : "{ip}"'


def test_investigate_neutral_400_when_truly_empty(client, mock_provider):
    r = client.post("/api/investigate", json={"entity": {"type": "ip", "value": "198.51.100.77"}})
    assert r.status_code == 400
    detail = r.json()["detail"]
    # NEUTRAL + specific so the FE can render an empty-state, not a scary error.
    assert "No events found" in detail
    assert "198.51.100.77" in detail
    # The widest rung was tried (~1 year), named in words, never the raw token (FXE).
    assert "the last 365 days" in detail and "now-365d" not in detail


def test_investigate_respects_requested_lookback_override(client, mock_provider):
    ip = "203.0.113.55"
    _seed(client, ip=ip, ts_millis=_ms_ago(days=3))  # within 7d, outside 24h

    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.3, 'source.ip : "x"'))

    # Per-request override starts at now-7d (additive field forwarded by the proxy).
    r = client.post(
        "/api/investigate",
        json={"entity": {"type": "ip", "value": ip}, "lookback": "now-7d"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["entity"]["value"] == ip


# --------------------------------------------------------------------------- #
# TASK B — manual provenance: trigger_reason, origin_surface, reproduce_query
# --------------------------------------------------------------------------- #
def test_manual_investigate_sets_trigger_reason_origin_and_normalized_query(client, mock_provider):
    ip = "192.0.2.42"
    _seed(client, ip=ip, ts_millis=_ms_ago(hours=1))
    _seed(client, ip=ip, ts_millis=_ms_ago(hours=2))

    _route_to_investigator(mock_provider)
    # Investigator returns a BARE `ip:` reproduce query — must be normalized.
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.4, f"ip:{ip}"))

    r = client.post("/api/investigate", json={"entity": {"type": "ip", "value": ip}})
    assert r.status_code == 200, r.text
    body = r.json()

    # "Why this fired" renders: a non-null, human sentence with mode=manual.
    assert body["trigger_reason"] is not None
    assert body["trigger_reason"]["sentence"]
    assert "Manually investigated" in body["trigger_reason"]["sentence"]
    assert body["trigger_reason"]["mode"] == "manual"

    # origin_surface persisted on first create.
    assert body["origin_surface"] == SourceSurface.INVESTIGATE.value
    assert body["source_surface"] == SourceSurface.INVESTIGATE.value

    # reproduce_query normalized to configured field syntax, never a bare ip:.
    assert body["reproduce_query"] == f'source.ip : "{ip}"'
    assert not body["reproduce_query"].startswith("ip:")


def test_manual_investigate_event_ids_path_sets_trigger_reason(client, mock_provider):
    ip = "192.0.2.99"
    eid = _seed(client, ip=ip, ts_millis=_ms_ago(hours=1))

    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.4, ""))

    r = client.post("/api/investigate", json={"event_ids": [eid], "group_by": "ip"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["trigger_reason"] is not None
    assert body["trigger_reason"]["mode"] == "manual"
    # Empty reproduce_query falls back to the entity field syntax (normalized).
    assert body["reproduce_query"] == f'source.ip : "{ip}"'


# --------------------------------------------------------------------------- #
# TASK C — C3-4: POST /cases/{id}/investigate
# --------------------------------------------------------------------------- #
def test_case_investigate_reruns_preserves_provenance_and_grows_history(client, mock_provider):
    ip = "192.0.2.150"
    _seed(client, ip=ip, ts_millis=_ms_ago(hours=1))
    _seed(client, ip=ip, ts_millis=_ms_ago(hours=2))

    # First create the case via a manual investigate, but stamp it as an AUTOMATED
    # SCAN surface so we can prove provenance is preserved across re-investigate.
    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2, 'source.ip : "x"'))
    r1 = client.post(
        "/api/investigate",
        json={"entity": {"type": "ip", "value": ip}, "source_surface": "automated_scan"},
    )
    assert r1.status_code == 200, r1.text
    case_id = r1.json()["case_id"]
    assert r1.json()["origin_surface"] == SourceSurface.AUTOMATED_SCAN.value
    assert len(r1.json()["verdict_history"]) == 1

    # Human-triggered re-investigation of the stored OPEN case (force) — a DIFFERENT
    # verdict this time; the SAME case must update in place.
    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.9, 'source.ip : "x"'))
    r2 = client.post(f"/api/cases/{case_id}/investigate")
    assert r2.status_code == 200, r2.text
    body = r2.json()

    assert body["case_id"] == case_id                       # same case, in place
    assert body["verdict"] == "TRUE_POSITIVE"               # genuinely re-investigated
    assert len(body["verdict_history"]) == 2                # history appended
    assert body["verdict_history"][-1]["verdict"] == "TRUE_POSITIVE"
    # Provenance preserved: an automated_scan case stays a scan.
    assert body["source_surface"] == SourceSurface.AUTOMATED_SCAN.value
    assert body["origin_surface"] == SourceSurface.AUTOMATED_SCAN.value


def test_case_investigate_404_for_missing_case(client):
    r = client.post("/api/cases/does-not-exist/investigate")
    assert r.status_code == 404


def test_case_investigate_400_when_events_aged_out(client, mock_provider):
    ip = "192.0.2.222"
    eid = _seed(client, ip=ip, ts_millis=_ms_ago(hours=1))

    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2, 'source.ip : "x"'))
    r1 = client.post("/api/investigate", json={"event_ids": [eid], "group_by": "ip"})
    assert r1.status_code == 200, r1.text
    case_id = r1.json()["case_id"]

    # Simulate the events aging out of the retained window: delete the log doc, so
    # neither the id re-query nor the config-windowed entity re-query find anything.
    es = client.app.state.tlsoc.es
    for index in list(es.docs.keys()):
        es.docs[index].pop(eid, None)

    r2 = client.post(f"/api/cases/{case_id}/investigate")
    assert r2.status_code == 400
    assert "No events remain" in r2.json()["detail"]


async def test_signature_lock_registry_is_weakly_bounded(app_state):
    # audit #42: the per-signature lock registry must not accumulate a lock per distinct
    # signature forever — an unused lock is dropped once no caller holds it.
    import gc

    pipeline = app_state.pipeline
    lock = pipeline.signature_lock("sig-weak-1")
    assert "sig-weak-1" in pipeline._sig_locks  # held → present
    del lock
    gc.collect()
    assert "sig-weak-1" not in pipeline._sig_locks  # no strong ref → evicted
