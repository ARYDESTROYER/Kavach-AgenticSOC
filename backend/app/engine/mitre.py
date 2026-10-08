"""MITRE ATT&CK technique lookup over the bundled compact map (F11).

Loads ``app/threat/mitre_techniques.json`` ONCE (process-cached) and serves
technique metadata for the threat-context panel. The bundled map is a compact,
curated subset of MITRE ATT&CK Enterprise (``{technique_id: {name, tactics[],
platforms[], url, description}}``) — NOT the full STIX bundle. See
``app/threat/SOURCE.md`` for the source + the refresh script.

FAIL-OPEN: a missing / unparseable bundle degrades to an EMPTY map (every lookup
returns ``None``) — it never raises, so the threat-context panel never breaks just
because the corpus is absent or stale.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger("tlsoc.engine.mitre")

# The committed compact map lives beside the bundled corpus.
_BUNDLE_PATH = Path(__file__).resolve().parent.parent / "threat" / "mitre_techniques.json"

# A MITRE technique id: T#### optionally with a .### sub-technique suffix.
_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")

# Process-level cache (the bundle is read-only at runtime).
_CACHE: dict[str, dict[str, Any]] | None = None


def _load() -> dict[str, dict[str, Any]]:
    """Load + cache the compact technique map. Never raises (→ {} on any failure)."""
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    data: dict[str, dict[str, Any]] = {}
    try:
        raw = json.loads(_BUNDLE_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            for tid, meta in raw.items():
                if isinstance(meta, dict):
                    data[str(tid).upper()] = meta
        logger.info("Loaded %d MITRE techniques from %s", len(data), _BUNDLE_PATH)
    except FileNotFoundError:
        logger.warning("MITRE bundle not found at %s; technique lookups disabled", _BUNDLE_PATH)
    except Exception as exc:  # noqa: BLE001 — corpus must never break the panel
        logger.warning("Could not load MITRE bundle (%s); technique lookups disabled", exc)
    _CACHE = data
    return data


def _normalize(technique_id: str | None) -> str | None:
    """Canonicalise a technique id (uppercase, trimmed) or None if not a valid id."""
    if not technique_id:
        return None
    tid = str(technique_id).strip().upper()
    return tid if _TECHNIQUE_RE.match(tid) else None


def technique(technique_id: str | None) -> dict[str, Any] | None:
    """Return the compact metadata dict for ``technique_id`` (e.g. ``"T1110"``), or
    ``None`` when it is unknown / invalid.

    Falls back from a sub-technique (``T1110.001``) to its PARENT (``T1110``) when
    the sub-technique itself is not in the compact bundle, so a more-specific id
    still resolves to useful context. The returned dict always carries the resolved
    ``id`` so callers can show which technique matched."""
    data = _load()
    tid = _normalize(technique_id)
    if tid is None:
        return None
    meta = data.get(tid)
    if meta is None and "." in tid:
        parent = tid.split(".", 1)[0]
        meta = data.get(parent)
        if meta is not None:
            tid = parent
    if meta is None:
        return None
    return {"id": tid, **meta}


def map_many(technique_ids: list[str] | None) -> list[dict[str, Any]]:
    """Resolve a list of technique ids to their metadata, dropping unknowns and
    de-duplicating by resolved id (preserving first-seen order). Never raises."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in technique_ids or []:
        meta = technique(raw)
        if meta is None:
            continue
        if meta["id"] in seen:
            continue
        seen.add(meta["id"])
        out.append(meta)
    return out


_WORD_RE = re.compile(r"[a-z0-9]+")


def search(
    query: str | None = None, *, tactic: str | None = None, limit: int = 8
) -> list[dict[str, Any]]:
    """Name/keyword (and optional tactic) search over the bundled corpus (chat
    ``mitre_lookup``). Pure and deterministic; never raises.

    A query that IS a technique id resolves like :func:`technique`. Otherwise each
    query word scores 3 when it is a word of the technique name and 1 when it only
    appears in the description; every word must match somewhere (AND), so "brute
    force" does not return every technique that mentions "force". ``tactic`` keeps
    techniques whose tactic list contains it (case-insensitive, substring, so
    "credential" matches "Credential Access"). Ties break on the id so the order is
    stable. With only a tactic, the tactic's techniques are returned in id order.
    ``limit`` is clamped to 1..50."""
    data = _load()
    cap = max(1, min(int(limit or 8), 50))
    text = str(query or "").strip()
    tactic_text = str(tactic or "").strip().lower()

    def tactic_ok(meta: dict[str, Any]) -> bool:
        if not tactic_text:
            return True
        return any(tactic_text in str(t).lower() for t in meta.get("tactics") or [])

    exact = technique(text) if text else None
    if exact is not None:
        return [exact] if tactic_ok(exact) else []
    words = list(dict.fromkeys(_WORD_RE.findall(text.lower())))[:12]
    if not words and not tactic_text:
        return []
    scored: list[tuple[int, str]] = []
    for tid, meta in data.items():
        if not tactic_ok(meta):
            continue
        if not words:
            scored.append((0, tid))
            continue
        name_words = set(_WORD_RE.findall(str(meta.get("name") or "").lower()))
        description = str(meta.get("description") or "").lower()
        score = 0
        for word in words:
            if word in name_words:
                score += 3
            elif word in description:
                score += 1
            else:
                score = -1
                break
        if score > 0:
            scored.append((score, tid))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [{"id": tid, **data[tid]} for _score, tid in scored[:cap]]


def loaded_count() -> int:
    """Number of techniques currently loaded (0 when the bundle is absent)."""
    return len(_load())


def _reset_cache_for_tests() -> None:  # pragma: no cover - test helper
    """Clear the process cache (used by tests that patch the bundle path)."""
    global _CACHE
    _CACHE = None
