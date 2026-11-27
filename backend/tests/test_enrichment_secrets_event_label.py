"""The audit log names an enrichment provider key change in words (Round 14 SPEC
§4.5.5, FX7d).

``POST /api/enrichment/providers/{name}/secrets`` writes an ``enrichment.secrets_updated``
row (and, when the store write fails, ``enrichment.secrets_update_failed``), like the
source and notification channel credential writers. Both read as Configuration and data
in People and settings, named in words, never as a System token.
"""

from __future__ import annotations

from app.audit import events
from app.audit.write import failure_action


def test_an_enrichment_key_change_reads_as_a_named_configuration_event() -> None:
    row = {"action": "enrichment.secrets_updated", "actor_type": "human"}
    assert events.classify(row) == events.EventInfo(
        "config", "Enrichment provider credentials changed")
    assert events.in_people_scope(row)


def test_its_failure_row_reads_in_the_same_category() -> None:
    failed = failure_action("enrichment.secrets_updated")
    assert failed == "enrichment.secrets_update_failed"
    info = events.classify({"action": failed, "actor_type": "human", "outcome": "failure"})
    assert info.category == "config"
    assert info.label.startswith("Enrichment") and "_" not in info.label
