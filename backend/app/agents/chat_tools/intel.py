"""Intel tools: ``lookup_indicator``, ``mitre_lookup`` and ``search_knowledge``
(chat revamp SPEC §5.3, §4.8).

* ``lookup_indicator`` is the only chat tool that sends data out of the deployment
  (third-party enrichment). Every value passes kind validation and the taint rule of
  :mod:`app.agents.chat_tools.taint` first, the per-turn and per-conversation lookup
  budgets apply, results come through the Redis-cached dispatcher (#8), and every
  provider string stays untrusted (#9). Demo Mode dispatches nothing and returns a
  deterministic result labelled synthetic.
* ``mitre_lookup`` reads the bundled ATT&CK corpus (``engine.mitre``): names and
  tactics are resolved server-side, never by the model.
* ``search_knowledge`` retrieves from the RAG corpus WITHOUT seeding or reseeding it
  (``RagService.retrieve_observed(allow_seed=False, allow_reseed=False)``: one
  query-embedding call through the gateway with ``surface="chat"``, reported as
  embedding usage). Its observation carries each chunk's source label and only
  APPROVED operator memory. The ONE renderer of that observation for a prompt is the
  engine's ``agents.chat._knowledge_trust_split`` (SPEC A16): it re-derives trust from
  each source label (never from a flag in the observation), lifts curated runbook /
  ATT&CK / suppression chunks and approved memory into TRUSTED reference lines, and
  keeps every other chunk inside the observation's UNTRUSTED fence.
"""

from __future__ import annotations

import hashlib
import inspect
import logging
import re
from typing import Any, ClassVar, Literal

from pydantic import Field, field_validator

from ...constants import IndicatorKind
from ...models import Citation, StepUsage
from .base import Artifact, ChatTool, ChatToolContext, ToolOutcome
from .common import (
    MAX_CITATIONS_PER_CALL,
    ToolInput,
    citation_id,
    column,
    current_call,
    finite,
    fmt_int,
    kpi,
    none_if_blank,
    opt_text,
    parse_input,
    text,
)
from .taint import KIND_ALIASES, REFUSED_TAINT, lookup_left_deployment, validate_indicator

logger = logging.getLogger("tlsoc.agents.chat_tools.intel")

_ENTITY_KIND = {
    IndicatorKind.IP: "ip", IndicatorKind.DOMAIN: "domain", IndicatorKind.URL: "url",
    IndicatorKind.FILE_HASH: "hash", IndicatorKind.EMAIL: "email", IndicatorKind.HOST: "host",
}
_MALICIOUS_AT = 50.0
_SUSPICIOUS_AT = 25.0


# --------------------------------------------------------------------------- #
# lookup_indicator
# --------------------------------------------------------------------------- #
class LookupIndicatorInput(ToolInput):
    indicator: str = Field(min_length=1, max_length=512)
    kind: Literal["ip", "domain", "url", "file_hash", "hash", "email", "host"] | None = None

    @field_validator("indicator", mode="before")
    @classmethod
    def _indicator(cls, value: Any) -> Any:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
        return value

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, value: Any) -> Any:
        value = none_if_blank(value)
        if isinstance(value, str):
            key = value.strip().lower()
            return {"sha256": "hash", "md5": "hash", "sha1": "hash", "ipv4": "ip", "ipv6": "ip",
                    "hostname": "host", "fqdn": "domain"}.get(key, key)
        return value


def _verdict_of(score: Any, malicious: Any, ok: bool) -> str:
    if not ok:
        return "unknown"
    if malicious is True or (finite(score) is not None and finite(score) >= _MALICIOUS_AT):
        return "malicious"
    if finite(score) is not None and finite(score) >= _SUSPICIOUS_AT:
        return "suspicious"
    if finite(score) is not None or malicious is False:
        return "clean"
    return "unknown"


def demo_reputation(value: str, kind: IndicatorKind) -> dict[str, Any]:
    """A deterministic, clearly synthetic reputation for Demo Mode (no I/O). The
    demo dataset's documentation-range "attacker" addresses score high so the demo
    storyline reads coherently; everything else scores from a stable hash."""
    digest = int(hashlib.sha256(f"{kind.value}:{value}".encode()).hexdigest()[:8], 16)
    bad_prefixes = ("203.0.113.", "198.51.100.", "192.0.2.")
    score = 72 + digest % 20 if value.startswith(bad_prefixes) else digest % 30
    return {
        "provider": "demo-synthetic",
        "score": score,
        "malicious": score >= _MALICIOUS_AT,
        "confidence": 0.5,
        "tags": ["demo", "synthetic"],
        "country": None,
    }


def bind_enrichment(*, prefs: Any, secrets: Any, cache: Any = None, registry: Any = None):
    """Build the ``ChatToolContext.enrich`` callable for a REAL (non-demo) request:
    ``await enrich(value, kind) -> list[ProviderResult]`` through the cached
    multi-provider dispatcher (``enrichment.dispatch.enrich_indicator``, #8), with
    the execution prefs' enrichment config. The route passes ``None`` in Demo Mode."""
    from ...enrichment.dispatch import enrich_indicator

    cfg = getattr(prefs, "enrichment", None)

    async def _enrich(value: str, kind: IndicatorKind) -> list[Any]:
        if cfg is not None and not getattr(cfg, "enabled", True):
            return []
        return await enrich_indicator(value, kind, cfg, secrets, cache, registry=registry)

    return _enrich


class LookupIndicatorTool(ChatTool):
    name: ClassVar[str] = "lookup_indicator"
    label: ClassVar[str] = "Looked up an indicator"
    scope: ClassVar[str] = "intel"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("enrichment", "read"),)
    data_source: ClassVar[str] = "Threat-intel enrichment providers (cached)"
    signature: ClassVar[str] = (
        "lookup_indicator(indicator, kind?=ip|domain|url|hash|email|host) -- reputation of ONE public "
        "indicator that the user typed or a lookup found this turn (private/internal values are refused)"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("indicator", "kind")

    @staticmethod
    def available(ctx: ChatToolContext) -> bool:
        """``chat_agent.max_indicator_lookups == 0`` turns the tool off (§4.2)."""
        cfg = getattr(ctx.prefs, "chat_agent", None)
        return int(getattr(cfg, "max_indicator_lookups", 3) or 0) > 0

    @staticmethod
    def consumes_budget(outcome: ToolOutcome) -> bool:
        """Whether a finished call spends one of the turn's lookups: only when at
        least one provider answered. A kind no enabled provider covers, or a lookup
        every provider failed, gave the analyst nothing and is given back."""
        answered = (outcome.observation or {}).get("providers_answered")
        return bool(outcome.ok and outcome.status == "ok" and isinstance(answered, int) and answered > 0)

    @staticmethod
    def left_deployment(outcome: ToolOutcome) -> bool:
        """Whether a call that spent no per-turn lookup may still have sent the
        indicator out (every queried provider failed, or it timed out): it then counts
        toward the conversation egress cap at once, by the same rule the next turn's
        replay applies to the stored step (``taint.lookup_left_deployment``)."""
        return lookup_left_deployment(outcome.status, outcome.rows)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(LookupIndicatorInput, inp)
        if error is not None:
            return error
        cfg = getattr(ctx.prefs, "chat_agent", None)
        check = validate_indicator(
            args.indicator, args.kind,
            internal_domains=list(getattr(cfg, "internal_domains", []) or []),
            allow_email=bool(getattr(cfg, "allow_email_lookup", False)),
            demo=ctx.demo_active,
        )
        # Policy refusals: no grant would allow them (``refusal="policy"``).
        if not check.ok:
            return ToolOutcome.failure(f"Not looked up: {check.reason}", status="denied", refusal="policy")
        if not _taint_permits(ctx, check.value, args.indicator, check.kind):
            return ToolOutcome.failure(f"Not looked up: {REFUSED_TAINT}", status="denied", refusal="policy")
        # Budgets (per turn / per conversation) are enforced by the loop owner:
        # ``ChatToolbox.execute`` reserves one before this runs (see TaintLedger).
        kind = check.kind
        assert kind is not None
        demo = ctx.demo_active
        if demo:
            rows = [demo_reputation(check.value, kind)]
            fused = {"score": float(rows[0]["score"]), "malicious": rows[0]["malicious"],
                     "method": "demo_synthetic", "country": None}
        else:
            if ctx.enrich is None:
                return ToolOutcome.failure("Indicator enrichment is not available on this deployment")
            try:
                results = await _call(ctx.enrich, check.value, kind)
            except Exception as exc:  # noqa: BLE001 — fail open to an engine template
                logger.warning("lookup_indicator dispatch failed: %s", exc)
                return ToolOutcome.failure("The enrichment providers did not answer")
            from ...enrichment.aggregate import fuse

            fused_model = fuse(list(results or []), getattr(ctx.prefs, "enrichment", None))
            fused = {"score": fused_model.reputation_score, "malicious": fused_model.is_malicious,
                     "method": fused_model.method, "country": fused_model.country}
            rows = [
                {"provider": r.provider, "score": r.score, "malicious": r.malicious,
                 "confidence": r.confidence, "tags": list(r.tags or [])[:5], "ok": bool(r.ok),
                 "error": bool(r.error)}
                for r in (results or [])
            ]
        queried = len(rows)
        answered = sum(1 for r in rows if r.get("ok", True) and not r.get("error"))
        score = finite(fused["score"])
        verdict = _verdict_of(score, fused["malicious"], answered > 0) if queried else "unknown"
        observation = {
            "indicator": text(check.value, 512),
            "kind": kind.value,
            "reputation_score": score if queried else None,
            "is_malicious": bool(fused["malicious"]) if queried else None,
            "verdict": verdict,
            "method": fused["method"],
            "country": opt_text(fused.get("country"), 60),
            "providers_queried": queried,
            "providers_answered": answered,
            "providers": [
                {"provider": text(r.get("provider"), 60), "score": finite(r.get("score")),
                 "malicious": r.get("malicious"), "confidence": finite(r.get("confidence")),
                 "tags": [text(t, 60) for t in (r.get("tags") or [])[:5]],
                 "answered": bool(r.get("ok", True)) and not r.get("error")}
                for r in rows[:12]
            ],
            "synthetic_demo_result": demo,
        }
        if not queried:
            observation["note"] = "no enabled provider can look up this kind of indicator"
        reputation = [
            {"provider": text(r.get("provider"), 60) or "provider",
             "verdict": _verdict_of(r.get("score"), r.get("malicious"), bool(r.get("ok", True)) and not r.get("error")),
             "score": finite(r.get("score")),
             "detail": opt_text(", ".join(str(t) for t in (r.get("tags") or [])[:4]), 280)}
            for r in rows[:12]
        ]
        facts = [{"label": "Kind", "value": kind.value},
                 {"label": "Providers", "value": f"{answered} of {queried} answered"}]
        if demo:
            facts.append({"label": "Data", "value": "Demo Mode synthetic result (no provider queried)"})
        if fused.get("country"):
            facts.append({"label": "Country", "value": str(fused["country"])[:60], "untrusted": True})
        artifacts = [
            Artifact(id="a1", kind="entity", title="Indicator reputation", title_trusted=True,
                     data={"entity": {"kind": _ENTITY_KIND[kind], "value": check.value},
                           "risk": score if queried else None,
                           "facts": facts, "reputation": reputation},
                     provenance="source", untrusted_labels=True,
                     basis="cached" if not demo else None),
            Artifact(id="a2", kind="kpis", title="Reputation figures", title_trusted=True,
                     data={"items": [
                         kpi("score", "Reputation score", score if queried else None, "score", display="gauge"),
                         kpi("providers", "Providers answered", answered, context=f"of {queried} queried"),
                     ]},
                     provenance="source"),
        ]
        if queried:
            summary = f"Reputation {fmt_int(score)}/100 ({verdict}) from {answered} of {queried} providers"
        else:
            summary = "No enabled provider covers this kind of indicator"
        if demo:
            summary += " (Demo Mode synthetic result)"
        return ToolOutcome(
            ok=True, summary=summary, untrusted_params={"indicator": check.value[:200]},
            observation=observation, artifacts=artifacts, rows=queried,
            basis=None if demo else "cached",
        )


def _taint_of(ctx: ChatToolContext) -> Any:
    """The turn's taint ledger: the toolbox's per-call binding, else a ``taint``
    attribute on the context an engine passed to ``run`` (a per-call context)."""
    call = current_call()
    if call is not None and call.taint is not None:
        return call.taint
    return getattr(ctx, "taint", None)


def _taint_permits(ctx: ChatToolContext, value: str, raw: str, kind: Any) -> bool:
    """§4.8.3 taint rule; fails CLOSED when no ledger is bound. Accepts a
    :class:`TaintLedger` (``permits``) or any ledger exposing ``check(value, kind,
    egress=...) -> (allowed, reason)``."""
    taint = _taint_of(ctx)
    if taint is None:
        return False
    if callable(getattr(taint, "permits", None)):
        return bool(taint.permits(value) or taint.permits(raw))
    check = getattr(taint, "check", None)
    if callable(check):
        try:
            allowed, _reason = check(value, getattr(kind, "value", kind), egress=not ctx.demo_active)
        except Exception:  # noqa: BLE001 — an unusable ledger refuses
            return False
        return bool(allowed)
    return False


async def _call(fn: Any, *args: Any) -> Any:
    result = fn(*args)
    return await result if inspect.isawaitable(result) else result


# --------------------------------------------------------------------------- #
# mitre_lookup
# --------------------------------------------------------------------------- #
_TECHNIQUE_RE = re.compile(r"^[Tt]\d{4}(?:\.\d{3})?$")


class MitreLookupInput(ToolInput):
    ids: list[str] = Field(default_factory=list, max_length=20)
    query: str | None = Field(default=None, max_length=80)
    tactic: str | None = Field(default=None, max_length=40)
    limit: int = Field(default=8, ge=1, le=20)

    @field_validator("ids", mode="before")
    @classmethod
    def _ids(cls, value: Any) -> Any:
        if value in (None, ""):
            return []
        if isinstance(value, str):
            value = [v for v in re.split(r"[,\s]+", value) if v]
        if isinstance(value, list):
            return [str(v).strip() for v in value if isinstance(v, str) and _TECHNIQUE_RE.match(v.strip())]
        return value

    @field_validator("query", "tactic", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)


class MitreLookupTool(ChatTool):
    name: ClassVar[str] = "mitre_lookup"
    label: ClassVar[str] = "Looked up ATT&CK techniques"
    scope: ClassVar[str] = "intel"
    requires: ClassVar[tuple[tuple[str, str], ...]] = ()
    data_source: ClassVar[str] = "Bundled MITRE ATT&CK corpus"
    signature: ClassVar[str] = (
        "mitre_lookup(ids?=[T1110, T1110.003], query?, tactic?, limit?=8) -- ATT&CK techniques by id or "
        "keyword from the bundled corpus"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("ids", "query", "tactic", "limit")

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        if isinstance(params.get("ids"), list):
            params["ids"] = ",".join(str(i) for i in params["ids"][:8])
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        from ...engine import mitre as corpus

        args, error = parse_input(MitreLookupInput, inp)
        if error is not None:
            return error
        if not args.ids and not args.query and not args.tactic:
            return ToolOutcome.failure("Invalid input: give ids, a query or a tactic")
        found: list[dict[str, Any]] = []
        if args.ids:
            found.extend(corpus.map_many(args.ids))
        if args.query or args.tactic:
            for meta in corpus.search(args.query, tactic=args.tactic, limit=args.limit):
                if all(meta["id"] != f["id"] for f in found):
                    found.append(meta)
        found = found[: max(args.limit, len(args.ids))]
        techniques = []
        for meta in found:
            tactics = [str(t) for t in (meta.get("tactics") or [])]
            techniques.append({
                "id": meta["id"], "name": str(meta.get("name") or "")[:120],
                "tactics": tactics[:4],
                "platforms": [str(p) for p in (meta.get("platforms") or [])][:6],
                "description": text(meta.get("description"), 400),
            })
        observation = {"query": args.query, "tactic": args.tactic, "requested_ids": args.ids,
                       "techniques": techniques, "corpus": "bundled ATT&CK (compact)"}
        artifacts = []
        citations = []
        if techniques:
            artifacts.append(Artifact(
                id="a1", kind="mitre", title="ATT&CK techniques", title_trusted=True,
                data={"techniques": [{"id": t["id"], "name": t["name"],
                                      "tactic": t["tactics"][0] if t["tactics"] else None} for t in techniques]},
                provenance="code",
            ))
            for i, t in enumerate(techniques[:MAX_CITATIONS_PER_CALL], start=1):
                citations.append(Citation(id=citation_id("M", i, ctx), kind="mitre",
                                          title=f"{t['id']} {t['name']}", technique=t["id"]))
        # A sub-technique missing from the compact bundle resolves to its parent
        # (``engine.mitre.technique``): that is a resolution, reported as such, not
        # an unknown id.
        unresolved: list[str] = []
        resolved_as: dict[str, str] = {}
        for requested in args.ids:
            meta = corpus.technique(requested)
            if meta is None:
                unresolved.append(requested.upper())
            elif meta["id"] != requested.upper():
                resolved_as[requested.upper()] = meta["id"]
        if unresolved:
            observation["unresolved_ids"] = unresolved
        if resolved_as:
            observation["resolved_as_parent"] = resolved_as
        noun = "technique" if len(techniques) == 1 else "techniques"
        summary = f"{fmt_int(len(techniques))} ATT&CK {noun} found"
        return ToolOutcome(
            ok=True, summary=summary, observation=observation, artifacts=artifacts, citations=citations,
            rows=len(techniques), basis="exact",
            untrusted_params={k: v for k, v in (("query", args.query), ("tactic", args.tactic)) if v},
        )


# --------------------------------------------------------------------------- #
# search_knowledge
# --------------------------------------------------------------------------- #
def canonical_knowledge_kind(value: Any) -> Any:
    """The canonical ``search_knowledge`` kind (aliases folded; blank = search),
    shared by the input model and the toolbox grant check."""
    value = none_if_blank(value)
    if value is None:
        return "search"
    if isinstance(value, str):
        key = value.strip().lower().replace("-", "_").replace(" ", "_")
        return {"runbooks": "list_runbooks", "playbooks": "list_playbooks",
                "runbook": "list_runbooks", "playbook": "list_playbooks"}.get(key, key)
    return value


class SearchKnowledgeInput(ToolInput):
    kind: Literal["search", "list_runbooks", "list_playbooks"] = "search"
    query: str | None = Field(default=None, max_length=300)
    top_k: int = Field(default=4, ge=1, le=8)

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, value: Any) -> Any:
        return canonical_knowledge_kind(value)

    @field_validator("query", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)


_WORD_RE = re.compile(r"[a-z0-9]{3,}")


def _memory_matches(entries: list[Any], query: str, limit: int = 3) -> list[Any]:
    """Approved operator memory that shares words with the query (no embedding)."""
    words = set(_WORD_RE.findall(query.lower()))
    if not words:
        return []
    scored = []
    for entry in entries:
        if getattr(entry, "review_status", "approved") != "approved":
            continue  # pending (agent-authored) memory is never trusted context
        hits = len(words & set(_WORD_RE.findall(str(getattr(entry, "text", "")).lower())))
        if hits:
            scored.append((hits, str(getattr(entry, "id", "")), entry))
    scored.sort(key=lambda s: (-s[0], s[1]))
    return [e for _h, _i, e in scored[:limit]]


def knowledge_signature(kinds: Any) -> str:
    """The one-line signature listing only ``kinds``."""
    listed = [k for k in ("search", "list_runbooks", "list_playbooks") if k in set(kinds)]
    kind = f"kind?={'|'.join(listed)}, " if len(listed) > 1 else ""
    return (
        f"search_knowledge({kind}query? (for search), top_k?=4) -- runbooks, ATT&CK and suppression "
        "guidance, approved operator memory and imported intel; cite as K1.."
    )


class SearchKnowledgeTool(ChatTool):
    name: ClassVar[str] = "search_knowledge"
    label: ClassVar[str] = "Searched the knowledge base"
    scope: ClassVar[str] = "intel"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("rag", "read"),)
    kind_permissions: ClassVar[dict[str, tuple[str, str]]] = {
        "list_runbooks": ("runbooks", "read"),
        "list_playbooks": ("playbooks", "read"),
    }
    optional_grants: ClassVar[tuple[tuple[str, str], ...]] = (("memory", "read"),)
    data_source: ClassVar[str] = "Knowledge base (runbooks, ATT&CK guidance, approved memory, imported intel)"
    # The full catalogue signature; a caller's prompt gets :meth:`signature_for`.
    signature: ClassVar[str] = knowledge_signature(("search", "list_runbooks", "list_playbooks"))
    display_keys: ClassVar[tuple[str, ...]] = ("kind", "query", "top_k")

    @staticmethod
    def canonical_kind(value: Any) -> Any:
        return canonical_knowledge_kind(value)

    def signature_for(self, ctx: ChatToolContext) -> str | None:
        """The caller's signature: ``search`` plus only the listing kinds it holds the
        grant for, so the model is never invited into a denial (and its audit row)."""
        return knowledge_signature(["search", *self.allowed_kinds(ctx.grants)])

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(SearchKnowledgeInput, inp)
        if error is not None:
            return error
        missing = ctx.missing(self, args.kind)
        if missing:  # defence in depth: the toolbox already refused (and audited) this
            return ToolOutcome.failure("Not permitted: requires " + ", ".join(missing), status="denied")
        if args.kind == "list_runbooks":
            return await self._list_runbooks(ctx)
        if args.kind == "list_playbooks":
            return await self._list_playbooks(ctx)
        if not args.query or len(args.query) < 2:
            return ToolOutcome.failure("Invalid input: check query")
        return await self._search(ctx, args)

    async def _search(self, ctx: ChatToolContext, args: SearchKnowledgeInput) -> ToolOutcome:
        from ...llm.gateway import UsageReceipt
        from ...tools.rag import is_trusted_knowledge

        query = args.query or ""
        chunks: list[Any] = []
        status = "unavailable"
        embedding: StepUsage | None = None
        if ctx.rag is not None:
            receipt = UsageReceipt()
            try:
                obs = await ctx.rag.retrieve_observed(
                    query, top_k=args.top_k, allow_seed=False, allow_reseed=False,
                    surface="chat", usage_receipt=receipt,
                )
                chunks = list(obs.chunks or [])
                status = "completed" if obs.measured else str(obs.reason or "unavailable")
            except Exception as exc:  # noqa: BLE001 — knowledge is optional context
                logger.info("search_knowledge retrieval failed: %s", exc)
                status = "retrieval_failed"
            if receipt.rows > 0:
                embedding = StepUsage(
                    embedding_calls=1,
                    embedding_tokens=int(receipt.prompt_tokens or 0),
                    embedding_cost=float(receipt.cost or 0.0),
                    estimated=bool(receipt.usage_estimated),
                    latency_ms=int(receipt.latency_ms or 0),
                )
        memory: list[Any] = []
        if ctx.memory is not None and ctx.has("memory", "read"):
            try:
                memory = _memory_matches(await ctx.memory.list(active_only=True), query)
            except Exception as exc:  # noqa: BLE001
                logger.info("search_knowledge memory read failed: %s", exc)
        obs_chunks = []
        citations: list[Citation] = []
        table_rows = []
        # One citation id per result, unique within the turn (``citation_id``); at most
        # nine per call, chunks first, then approved memory.
        memory = memory[: max(0, MAX_CITATIONS_PER_CALL - len(chunks[:MAX_CITATIONS_PER_CALL]))]
        chunks = chunks[:MAX_CITATIONS_PER_CALL]
        for i, chunk in enumerate(chunks, start=1):
            source = str(getattr(chunk, "source", "") or "imported")
            trusted = is_trusted_knowledge(source)
            meta = getattr(chunk, "metadata", None) or {}
            title = str(meta.get("title") or meta.get("document_id") or source)
            body = str(getattr(chunk, "text", "") or "")
            ref = citation_id("K", i, ctx)
            obs_chunks.append({"ref": ref, "source": text(source, 64), "trusted": trusted,
                               "title": text(title, 120), "text": text(body, 600),
                               "score": round(float(getattr(chunk, "score", 0.0) or 0.0), 3)})
            citations.append(Citation(id=ref, kind="knowledge", title=title[:200] or source,
                                      untrusted=not trusted, snippet=body[:280] or None))
            table_rows.append([ref, source, "curated" if trusted else "untrusted", title,
                               body[:300], round(float(getattr(chunk, "score", 0.0) or 0.0), 3)])
        obs_memory = []
        for j, entry in enumerate(memory, start=len(chunks) + 1):
            ref = citation_id("K", j, ctx)
            body = str(getattr(entry, "text", "") or "")
            obs_memory.append({"ref": ref, "trust": "approved", "text": text(body, 400)})
            citations.append(Citation(id=ref, kind="knowledge", title="Operator memory",
                                      untrusted=False, snippet=body[:280] or None))
            table_rows.append([ref, "memory", "approved memory", "Operator memory", body[:300], None])
        observation = {
            "query": query, "status": status, "chunks": obs_chunks, "memory": obs_memory,
            "note": None if status == "completed" else "the knowledge index was not searched or not verified; results may be missing",
        }
        artifacts = []
        if table_rows:
            artifacts.append(Artifact(
                id="a1", kind="table", title="Knowledge results", title_trusted=True,
                data={"columns": [
                    column("ref", "Ref"), column("source", "Source"), column("trust", "Trust"),
                    column("title", "Title", untrusted=True), column("excerpt", "Excerpt", untrusted=True),
                    column("score", "Score", "number", align="right"),
                ], "rows": table_rows},
                provenance="code", untrusted_labels=True,
            ))
        artifacts.append(Artifact(
            id=f"a{len(artifacts) + 1}", kind="guide", title="Knowledge pages", title_trusted=True,
            data={"links": [{"label": "Open Knowledge", "ref": {"page": "knowledge"}},
                            {"label": "Open Runbooks", "ref": {"page": "runbooks"}}]},
            provenance="code",
        ))
        n = len(obs_chunks) + len(obs_memory)
        summary = f"{fmt_int(n)} knowledge results"
        if status != "completed":
            summary += f" (index status: {status.replace('_', ' ')})"
        return ToolOutcome(
            ok=True, summary=summary, untrusted_params={"query": query[:200]},
            observation=observation, artifacts=artifacts, citations=citations, rows=n,
            embedding=embedding,
        )

    async def _list_runbooks(self, ctx: ChatToolContext) -> ToolOutcome:
        service = getattr(ctx, "runbooks", None)
        rows: list[dict[str, Any]] = []
        bundled_only = service is None
        try:
            if service is not None:
                for record in await service.list():
                    rb = record.runbook
                    rows.append({"id": rb.id, "title": rb.title, "persona": rb.persona,
                                 "rules": list(rb.applies_to_rules)[:3],
                                 "techniques": list(rb.applies_to_techniques)[:3],
                                 "origin": record.source_type})
            else:
                from ...engine.runbooks import load_runbooks

                for rb in load_runbooks():
                    rows.append({"id": rb.id, "title": rb.title, "persona": rb.persona,
                                 "rules": list(rb.applies_to_rules)[:3],
                                 "techniques": list(rb.applies_to_techniques)[:3], "origin": "bundled"})
        except Exception as exc:  # noqa: BLE001
            logger.info("runbook catalogue unavailable: %s", exc)
            return ToolOutcome.failure("The runbook catalogue is not available")
        observation = {
            "runbooks": [{k: (text(v, 120) if isinstance(v, str) else [text(x, 60) for x in v])
                          for k, v in r.items()} for r in rows[:40]],
            "total": len(rows),
            "catalogue": "bundled only" if bundled_only else "bundled and operator",
        }
        artifacts = [
            Artifact(id="a1", kind="table", title="Runbooks", title_trusted=True, data={
                "columns": [column("id", "Id", "code"), column("title", "Title", untrusted=True),
                            column("persona", "Persona"), column("techniques", "Techniques", "code"),
                            column("origin", "Origin")],
                "rows": [[r["id"], r["title"], r["persona"], ", ".join(r["techniques"]), r["origin"]]
                         for r in rows[:200]],
            }, provenance="code", untrusted_labels=True, total=len(rows), truncated=len(rows) > 200),
            Artifact(id="a2", kind="guide", title="Runbook pages", title_trusted=True,
                     data={"links": [{"label": "Open Runbooks", "ref": {"page": "runbooks"}}]}, provenance="code"),
        ]
        summary = f"{fmt_int(len(rows))} runbooks" + (" (bundled catalogue)" if bundled_only else "")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(rows), basis="exact")

    async def _list_playbooks(self, ctx: ChatToolContext) -> ToolOutcome:
        registry = getattr(ctx, "playbooks", None)
        bundled_only = registry is None
        try:
            if registry is not None:
                playbooks = list(registry.all())
            else:
                from pathlib import Path

                from ...playbooks.loader import load_playbooks

                directory = Path(__file__).resolve().parents[3] / "playbooks"
                playbooks = load_playbooks(directory)
        except Exception as exc:  # noqa: BLE001
            logger.info("playbook catalogue unavailable: %s", exc)
            return ToolOutcome.failure("The playbook catalogue is not available")
        rows = []
        for pb in playbooks:
            manifest = pb.manifest
            rows.append({"id": manifest.id, "name": manifest.name, "version": manifest.version,
                         "description": manifest.description, "priority": manifest.priority})
        rows.sort(key=lambda r: (-int(r["priority"] or 0), r["id"]))
        observation = {
            "playbooks": [{"id": text(r["id"], 80), "name": text(r["name"], 120), "version": r["version"],
                           "description": text(r["description"], 200)} for r in rows[:40]],
            "total": len(rows),
            "catalogue": "bundled only" if bundled_only else "loaded catalogue",
        }
        artifacts = [
            Artifact(id="a1", kind="table", title="Playbooks", title_trusted=True, data={
                "columns": [column("id", "Id", "code"), column("name", "Name", untrusted=True),
                            column("version", "Version", "number", align="right"),
                            column("description", "Description", untrusted=True)],
                "rows": [[r["id"], r["name"], r["version"], r["description"]] for r in rows[:200]],
            }, provenance="code", untrusted_labels=True, total=len(rows), truncated=len(rows) > 200),
            Artifact(id="a2", kind="guide", title="Playbook pages", title_trusted=True,
                     data={"links": [{"label": "Open Playbooks", "ref": {"page": "playbooks"}}]}, provenance="code"),
        ]
        summary = f"{fmt_int(len(rows))} playbooks" + (" (bundled catalogue)" if bundled_only else "")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           rows=len(rows), basis="exact")


__all__ = [
    "LookupIndicatorTool",
    "MitreLookupTool",
    "SearchKnowledgeTool",
    "bind_enrichment",
    "demo_reputation",
]

# Kinds accepted by lookup_indicator (re-exported for the catalogue/tests).
INDICATOR_KINDS: tuple[str, ...] = tuple(KIND_ALIASES)
