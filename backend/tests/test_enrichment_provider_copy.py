"""The enrichment provider cards' copy follows the Console copy rule (Round 14 SPEC copy
rule: no em dashes).

Settings > Enrichment shows each provider's description, free-tier note, setup steps
and example verbatim from its manifest (``GET /api/enrichment/providers``). Those
strings date from Round 11 and carried 57 em dashes until the FX8 fix; these tests
keep every built-in manifest, and the listing the page reads, free of U+2014.
"""

from __future__ import annotations

from typing import Any, Iterator

from app.api import routes_enrichment
from app.enrichment.registry import get_provider_registry

EM_DASH = "\u2014"


def _strings(value: Any, path: str = "") -> Iterator[tuple[str, str]]:
    """Every text value in ``value`` with its path (``providers[3].setup_steps[1]``)."""
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from _strings(item, f"{path}.{key}" if path else str(key))
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            yield from _strings(item, f"{path}[{index}]")


def _with_em_dash(value: Any) -> list[str]:
    return [f"{path}: {text[:80]!r}" for path, text in _strings(value) if EM_DASH in text]


def test_no_built_in_provider_manifest_holds_an_em_dash() -> None:
    manifests = get_provider_registry().manifests()
    assert len(manifests) >= 38  # every built-in provider (Round 11: 38 classes)
    offending = {
        m.name: found for m in manifests if (found := _with_em_dash(m.model_dump(mode="json")))
    }
    assert offending == {}


def test_the_enrichment_listing_the_settings_page_reads_holds_no_em_dash(client) -> None:
    client.app.include_router(routes_enrichment.router)
    response = client.get("/api/enrichment/providers")
    assert response.status_code == 200, response.text
    body = response.json()
    names = {p["name"] for p in body["providers"]}
    # The listing carries every registered provider, so this checks all of their copy.
    assert names >= set(get_provider_registry().names())
    # The fields the provider cards show are present (so the check is not vacuous).
    shown = [p for p in body["providers"] if p["description"] and p["setup_steps"] and p["example"]]
    assert len(shown) >= 38
    assert _with_em_dash(body) == []
