"""Threat-context panel assembly (Wave 6 / F11).

``assemble(case, prefs, *, enrich, rag, cases)`` builds a read-only
:class:`app.models.ThreatContextPanel` for a case: IOC reputation, MITRE technique
metadata, related (resolved) cases, asset context and evidence. Sections are
fetched in PARALLEL and each is FAIL-OPEN — a missing/erroring enrichment, MITRE
map or related-cases lookup degrades that one section to empty rather than failing
the whole panel.

The panel is ADVISORY and never participates in the deterministic decision (#3).
All free-text it carries is case/log-derived and is rendered as plain text / code
blocks by the UI (never trusted as instructions, #9).
"""

from __future__ import annotations

import asyncio
import inspect
import ipaddress
import logging
from typing import TYPE_CHECKING, Any

from ..config import Preferences
from ..constants import CaseStatus, EntityType, IndicatorKind
from ..models import Case, ThreatContextPanel
from ..utils import iso_now, truncate
from . import mitre as mitre_module
from .risk import _asset_criticality

# Round-3 Wave-2: map a correlation EntityType onto an enrichment IndicatorKind so a
# non-IP case entity (a domain, a file hash) gets enriched by the multi-provider
# dispatch. IP is handled by the byte-identical legacy path below; HOST/USER/RULE have
# no reputation indicator and are intentionally absent.
_ENTITY_TO_INDICATOR: dict[EntityType, IndicatorKind] = {
    EntityType.DOMAIN: IndicatorKind.DOMAIN,
    EntityType.FILE_HASH: IndicatorKind.FILE_HASH,
}

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..stores.cases import CaseStore
    from ..tools.enrich import EnrichTool
    from ..tools.rag import RagService

logger = logging.getLogger("tlsoc.engine.threat_context")


def _accepts_keyword(fn: Any, name: str) -> bool:
    """Whether ``fn`` takes the keyword ``name`` (or ``**kwargs``): a duck-typed
    enrichment object keeps its historical ``enrich_ip(ip)`` signature."""
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(p.name == name or p.kind is inspect.Parameter.VAR_KEYWORD for p in params)


def _provider_fields(results: list[Any], prefs: Preferences, status: str) -> dict[str, Any]:
    """The per-provider part of one indicator row (Round 16 SPEC §4.5 WP13, [dv] R7).

    ``providers``: one entry per provider asked, every provider string fenced (#9) by
    ``fence_provider_result``, plus ``cached`` (that provider's answer came from the
    cache). ``method``: how the providers were fused into ``score`` (``max`` by
    default, ``weighted`` when fusion is on); ``null`` when no provider result is known
    for the answer. ``errors``: each failed provider's error, fenced. ``providers_status``:
    ``checked`` (asked now), ``cached`` (kept beside a cached answer, or every provider
    answered from its cache), ``not_recorded`` (a cached answer kept without its
    provider results) or ``skipped`` (no provider was asked)."""
    from ..enrichment.aggregate import fence_provider_result, fence_provider_value, fuse

    if not results:
        return {"providers": [], "method": None, "errors": {}, "providers_status": status}
    fused = fuse(results, prefs.enrichment)
    return {
        "providers": [
            {**fence_provider_result(r), "cached": bool((r.raw or {}).get("_cached"))}
            for r in results
        ],
        "method": fused.method,
        "errors": {
            name: fence_provider_value(error, provider=name)
            for name, error in fused.errors.items()
        },
        "providers_status": status,
    }


async def _ioc_section(case: Case, prefs: Preferences, enrich: "EnrichTool | None") -> list[dict[str, Any]]:
    """IOC reputation for the case entity. FAIL-OPEN → [].

    The IP path keeps the Wave 1 answer (``enrich.enrich_ip`` → legacy
    ``EnrichmentResult``: the same ``score``, ``is_malicious``, ``country``, ``cached``
    and ``sources``). Round-3 Wave-2 ADDS a non-IP branch: a domain / file-hash
    entity is enriched through the multi-provider dispatch
    (``enrich.enrich_indicator``) and fused with the same default ``max()`` so the
    panel's ``score``/``is_malicious`` contract is unchanged. Round 16 (SPEC §4.5 WP13,
    [dv] R7) adds, on both paths, ``providers``, ``method``, ``errors`` and
    ``providers_status`` (:func:`_provider_fields`); the IP path reads them from the
    same ``enrich_ip`` call, so no provider is asked twice. This panel is read when
    the case is opened, so its reading can differ from the one the investigation
    used. Advisory only: this never feeds the deterministic decision (#3)."""
    cfg = prefs.threat_context
    threshold = int(getattr(cfg, "ioc_malicious_threshold", 50))
    try:
        if enrich is None:
            return []
        # --- IP: the legacy answer, plus the providers behind it. ---
        if case.entity.type == EntityType.IP:
            from ..tools.enrich import DETAIL_NOT_RECORDED, IpEnrichmentDetail

            detail: IpEnrichmentDetail | None = None
            if _accepts_keyword(enrich.enrich_ip, "detail"):
                detail = IpEnrichmentDetail()
                result = await enrich.enrich_ip(case.entity.value, detail=detail)
            else:
                result = await enrich.enrich_ip(case.entity.value)
            score = float(result.reputation_score)
            return [
                {
                    "indicator": case.entity.value,
                    "type": "ip",
                    "score": score,
                    # The panel's own threshold maps reputation → is_malicious (the
                    # enrichment tool's own 50-cut is independent; the panel is the
                    # operator-tunable display surface).
                    "is_malicious": score >= threshold,
                    "country": result.country,
                    "cached": result.cached,
                    "sources": result.sources,
                    **_provider_fields(
                        detail.providers if detail is not None else [], prefs,
                        (detail.status or DETAIL_NOT_RECORDED) if detail is not None
                        else DETAIL_NOT_RECORDED,
                    ),
                }
            ]
        # --- Non-IP (domain / file hash): the Wave-2 multi-provider path. ---
        kind = _ENTITY_TO_INDICATOR.get(case.entity.type)
        if kind is None:
            return []
        results = await enrich.enrich_indicator(case.entity.value, kind)
        if not results:
            return []
        # Default fusion is byte-identical max(score); fence every provider string (#9).
        from ..enrichment.aggregate import fuse

        fused = fuse(results, prefs.enrichment)
        score = float(fused.reputation_score)
        every_cached = all((r.raw or {}).get("_cached") for r in results)
        return [
            {
                "indicator": case.entity.value,
                "type": kind.value,
                "score": score,
                "is_malicious": score >= threshold,
                "country": fused.country,
                "cached": any((r.raw or {}).get("_cached") for r in results),
                "sources": fused.per_provider,
                # Per-provider detail with ALL untrusted strings fenced for the UI (#9).
                **_provider_fields(results, prefs, "cached" if every_cached else "checked"),
            }
        ]
    except Exception as exc:  # noqa: BLE001 — fail-open per section
        logger.warning("threat_context IOC section failed for %s: %s", case.case_id, exc)
        return []


async def _mitre_section(case: Case, prefs: Preferences) -> list[dict[str, Any]]:
    """Resolve the case's MITRE technique ids via the bundled map. FAIL-OPEN → []."""
    try:
        if not prefs.threat_context.mitre_enabled:
            return []
        return mitre_module.map_many(list(case.mitre or []))
    except Exception as exc:  # noqa: BLE001 — fail-open per section
        logger.warning("threat_context MITRE section failed for %s: %s", case.case_id, exc)
        return []


async def _related_section(
    case: Case, prefs: Preferences, rag: "RagService | None", cases: "CaseStore | None"
) -> list[dict[str, Any]]:
    """Surface prior RESOLVED cases for the same entity ("we've seen this before").

    Uses the RAG resolved-case corpus first (semantic recall), falling back to a
    direct entity scan of closed cases. FAIL-OPEN → []."""
    try:
        if not prefs.threat_context.reuse_resolved_cases:
            return []
        entity_key = f"{case.entity.type.value}:{case.entity.value}"
        out: list[dict[str, Any]] = []
        seen: set[str] = set()

        if rag is not None:
            try:
                await rag.ensure_seeded()
                chunks = await rag.retrieve(
                    f"{entity_key} {' '.join(case.rule_ids[:5])}", top_k=6
                )
                for ch in chunks:
                    if ch.source != "resolved_case":
                        continue
                    cid = str((ch.metadata or {}).get("case_id") or "")
                    if cid == case.case_id or (cid and cid in seen):
                        continue
                    if cid:
                        seen.add(cid)
                    out.append({
                        "case_id": cid,
                        "verdict": str((ch.metadata or {}).get("verdict") or ""),
                        "entity": str((ch.metadata or {}).get("entity") or ""),
                        "score": round(float(ch.score), 4),
                        "snippet": truncate(ch.text, 200),
                    })
            except Exception as exc:  # noqa: BLE001 — RAG recall is best-effort
                logger.debug("threat_context RAG related lookup failed: %s", exc)

        # Fallback / supplement: a direct scan of closed cases sharing the entity.
        if len(out) < 5 and cases is not None:
            try:
                closed, _total = await cases.list(status=CaseStatus.CLOSED.value, limit=200)
                for c in closed:
                    if c.case_id == case.case_id or c.case_id in seen:
                        continue
                    if c.entity.type == case.entity.type and c.entity.value == case.entity.value:
                        seen.add(c.case_id)
                        out.append({
                            "case_id": c.case_id,
                            "verdict": c.verdict.value if c.verdict else "",
                            "entity": entity_key,
                            "score": 1.0,  # exact entity match
                            "snippet": truncate(c.summary or c.recommended_action or "", 200),
                        })
                        if len(out) >= 8:
                            break
            except Exception as exc:  # noqa: BLE001
                logger.debug("threat_context closed-case scan failed: %s", exc)
        return out[:8]
    except Exception as exc:  # noqa: BLE001 — fail-open per section
        logger.warning("threat_context related section failed for %s: %s", case.case_id, exc)
        return []


# IPv4 documentation / benchmarking ranges Python's ``is_private`` lumps in but
# which are NOT real internal networks (so the panel doesn't mislabel a public
# example/TEST-NET address as "internal").
_DOC_NETWORKS = tuple(
    ipaddress.ip_network(c)
    for c in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "198.18.0.0/15")
)


def _is_internal_addr(addr: ipaddress._BaseAddress) -> bool:
    """Whether ``addr`` is an internal/owned address (RFC1918 / loopback / link-local),
    excluding the public documentation/benchmark ranges that ``is_private`` includes."""
    try:
        for doc in _DOC_NETWORKS:
            if addr in doc:
                return False
    except TypeError:  # IPv6 vs IPv4 mix — the ``in`` raises; not a doc range.
        pass
    return bool(addr.is_private or addr.is_loopback or addr.is_link_local)


def _asset_section(case: Case, prefs: Preferences) -> dict[str, Any]:
    """Asset context for the case entity (criticality + internal flag). FAIL-OPEN → {}."""
    try:
        entity_key = f"{case.entity.type.value}:{case.entity.value}"
        criticality = _asset_criticality(case.entity.value, prefs)
        is_internal = False
        matched_networks: list[str] = []
        if case.entity.type == EntityType.IP:
            try:
                addr = ipaddress.ip_address(case.entity.value)
                is_internal = _is_internal_addr(addr)
                for net in prefs.asset_networks or []:
                    try:
                        cidr = ipaddress.ip_network(net.cidr, strict=False)
                    except ValueError:
                        continue
                    if addr in cidr:
                        matched_networks.append(net.cidr)
            except ValueError:
                pass
        # A configured asset network is, by definition, an internal/owned network.
        if matched_networks:
            is_internal = True
        return {
            "entity": entity_key,
            "criticality": round(float(criticality), 2),
            "is_internal": is_internal,
            "networks": matched_networks,
        }
    except Exception as exc:  # noqa: BLE001 — fail-open per section
        logger.warning("threat_context asset section failed for %s: %s", case.case_id, exc)
        return {}


def _evidence_section(case: Case) -> list[dict[str, Any]]:
    """The case's own evidence items (already structured). FAIL-OPEN → []."""
    try:
        return [
            {
                "summary": truncate(ev.summary, 400),
                "event_ids": list(ev.event_ids or [])[:25],
                "query": ev.query or "",
            }
            for ev in (case.evidence or [])[:10]
        ]
    except Exception as exc:  # noqa: BLE001
        logger.warning("threat_context evidence section failed for %s: %s", case.case_id, exc)
        return []


async def assemble(
    case: Case,
    prefs: Preferences,
    *,
    enrich: "EnrichTool | None" = None,
    rag: "RagService | None" = None,
    cases: "CaseStore | None" = None,
) -> ThreatContextPanel:
    """Assemble the threat-context panel for ``case`` — PARALLEL + FAIL-OPEN.

    Each section is computed independently; a failing section degrades to its empty
    value (the whole call NEVER raises). The panel is read-only and advisory; it
    never touches the deterministic decision (#3)."""
    base = ThreatContextPanel(case_id=case.case_id, generated_at=iso_now())
    try:
        if not prefs.threat_context.enabled:
            return base

        ioc, mitre, related = await asyncio.gather(
            _ioc_section(case, prefs, enrich),
            _mitre_section(case, prefs),
            _related_section(case, prefs, rag, cases),
            return_exceptions=True,
        )
        base.ioc_reputation = ioc if isinstance(ioc, list) else []
        base.mitre_techniques = mitre if isinstance(mitre, list) else []
        base.related_cases = related if isinstance(related, list) else []
        # Pure/read-only projection of the already-persisted correlation facts. It
        # never re-runs clustering and hashes member identities before returning them.
        from .clustering_explain import build_clustering_explanation

        base.clustering = build_clustering_explanation(
            case, related_cases=base.related_cases,
        )
        # The asset + evidence sections are pure/local — compute them directly.
        base.asset_context = _asset_section(case, prefs)
        base.evidence = _evidence_section(case)
        return base
    except Exception as exc:  # noqa: BLE001 — the panel must never error out
        logger.warning("threat_context assembly failed for %s: %s", case.case_id, exc)
        return base
