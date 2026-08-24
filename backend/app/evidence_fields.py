"""The ONE definition of which raw event fields count as case evidence (#9-safe).

Three independent hardcoded allowlists used to decide, separately and silently,
what the agent could SEE and what it could SEARCH:

* ``agents/prompts.py`` rendered a fixed 7-key projection of every sample event
  under a heading that claimed to be "raw log data";
* ``tools/es_query.py`` returned a fixed 9-key row, so an investigator that
  noticed the gap could not query its way out of it;
* ``connectors/elastic.py`` matched free-text ``contains`` against four fields,
  so the missing evidence was not even searchable.

A field absent from all three is invisible AND unsearchable at once, and a
zero-hit query for it reads back to the model as positive evidence of absence.
That is how a detection whose whole verdict turns on ``url.path`` — is this a
stock application endpoint or an attacker-dropped file? — reached the
investigator with "no HTTP or execution context" while the field sat, populated,
on the alert document in memory.

This module is the single shared definition those three surfaces now import, so
they cannot drift apart again. It is deliberately dependency-light (``app.utils``
only) so every layer — connector, tool and prompt seam — can import it without a
cycle.

Two hard rules govern everything here.

**#9 (untrusted data).** Every value projected by :func:`project_evidence` is
attacker-influenceable, and in wildcard mode so is every KEY. Nothing here fences
anything: callers pass the result to ``fence_block``, which scrubs forged markers
in each leaf AND re-scrubs the serialised form (so keys are covered too). This
module's job is to bound the payload; the prompt seam's job is to fence it.

**#7 (aggregate-then-summarise).** Widening applies ONLY to the per-cluster
evidence surfaces that already carry per-event detail — the investigator/router
cluster render and the ``es_query`` tool rows. The standup, the event-detection
funnel and the shift report stay aggregate-only and must never import this.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Sequence

from .utils import dotted_get, truncate

# --------------------------------------------------------------------------- #
# The projection
# --------------------------------------------------------------------------- #

# The ECS fields that most often CARRY the verdict, in decision-relevance order —
# which is also the order the size budget keeps them in when it binds. These are
# added to each surface's pre-existing identity keys (id/ip/user/host/rule/…),
# never in place of them, so the previous projection is a strict subset of the
# new one and no deployment loses a field it had.
#
# Ordering rationale: ``event.action``/``event.outcome`` are cheap, near-universal
# and say WHAT happened; the ``url``/``http``/``user_agent`` group decides web
# detections (a stock endpoint vs. an attacker-dropped file, a browser vs.
# sqlmap); the ``process``/``file`` group decides endpoint detections;
# ``destination.ip`` is the egress tell. A deployment whose alerts do not carry a
# field simply never renders it — an absent field costs nothing.
DEFAULT_EVIDENCE_FIELDS: tuple[str, ...] = (
    "event.action",
    "event.outcome",
    "url.path",
    "url.original",
    "http.request.method",
    "http.response.status_code",
    "user_agent.original",
    "process.name",
    "process.command_line",
    "file.path",
    "destination.ip",
)

# Configuring the projection as exactly ``["*"]`` ships the WHOLE record instead of
# an allowlist, bounded only by the per-event size budget (which is the honest way
# round: a budget states what it withheld, an allowlist silently pretends the rest
# does not exist). It widens what the model SEES only — see
# :func:`searchable_evidence_fields` for why it does not widen what ES MATCHES on.
EVIDENCE_WILDCARD = "*"

# Rule DEFINITION metadata: large, static, identical on every alert the rule ever
# fires, and never evidence about THIS alert. In wildcard mode these are offered
# last, so when the budget binds they are what gets dropped — not the URL that
# decides the case. (In allowlist mode they are simply not in the list.)
BULKY_METADATA_FIELDS: frozenset[str] = frozenset({
    "kibana.alert.rule.parameters",
    "kibana.alert.rule.note",
    "kibana.alert.rule.description",
    "kibana.alert.rule.threat",
    "kibana.alert.rule.exceptions_list",
    "kibana.alert.rule.false_positives",
    "kibana.alert.rule.references",
    "kibana.alert.rule.investigation_fields",
    "kibana.alert.rule.setup",
    "kibana.alert.rule.related_integrations",
    "kibana.alert.rule.required_fields",
    "kibana.alert.rule.meta",
})

# Evidence paths that are worth SHOWING but not worth free-text SEARCHING, because
# their ECS type is not text: ``http.response.status_code`` is a ``long`` and
# ``destination.ip`` is an ``ip``. A substring match against either is meaningless
# (you cannot usefully find a status code or an IP by infix), and on a real cluster a
# non-lenient ``multi_match`` asking them to parse free text fails the WHOLE search.
# Excluding them keeps the executed query and its rendered KQL — the operator's
# Discover deep-link — both correct. The connector additionally passes
# ``lenient``, which is the safety net for operator-configured paths whose mapping
# type we cannot know from here.
NON_TEXT_SEARCH_FIELDS: frozenset[str] = frozenset({
    "http.response.status_code",
    "destination.ip",
})

# --------------------------------------------------------------------------- #
# Bounds
# --------------------------------------------------------------------------- #

# How many configured paths one projection may carry. Generous for any real field
# mapping; it exists so a malformed or hostile config cannot turn every prompt
# into a thousand-field walk.
MAX_EVIDENCE_FIELDS = 64

# How many fields free-text ``contains`` fans out over. A ``multi_match`` is
# executed once per field, so this is a real query cost on a large index.
MAX_SEARCH_FIELDS = 24

# Serialised-character budget for ONE projected event. The old ``fence()`` path
# hard-cut every sample event at 600 chars with no notice; this budget replaces
# that with an accounted bound that reports what it withheld. At the investigator's
# 12 sample events this caps the whole block at ~14 kB worst case, against a
# typical widened event of ~450 chars.
DEFAULT_EVIDENCE_MAX_CHARS_PER_EVENT = 1200

# Per-event ceiling for the CHEAP TRIAGE prompt. The router sees the same evidence
# FIELDS as the investigator — one definition, so triage and investigation cannot
# disagree about what an alert contains — but it runs on every cluster, so its
# per-event budget is capped separately. It is a ceiling, not a replacement: an
# operator who lowers the global budget lowers the router's with it. Comfortably
# above a typical widened event (~450 chars), so the deciding fields still land.
ROUTER_EVIDENCE_MAX_CHARS = 700

# Ceiling for an operator-raised budget. ``fence_block``'s own 16 kB safety net is
# the backstop behind this; keeping the per-event budget under it means the block
# is bounded by an accounted, reported cut rather than a blind byte truncation.
MAX_EVIDENCE_MAX_CHARS_PER_EVENT = 16000

# Per-VALUE bound inside a projection, so one 8 kB command line or stack trace
# cannot consume an entire event's budget and starve every other field.
EVIDENCE_MAX_VALUE_CHARS = 512

# Per-KEY bound. In wildcard mode the key is the RECORD's own field name, so it is
# attacker-sized as well as attacker-valued — and an unbounded one is charged to the
# budget whether it is kept (as a key) or dropped (as an ``_omitted_fields`` entry),
# so bounding the value alone leaves the budget unbounded either way.
EVIDENCE_MAX_KEY_CHARS = 128

# How many withheld field names are named back to the model. Naming them is the
# point (silence is what made the original bug invisible); naming a thousand is
# just more prompt.
MAX_OMITTED_REPORTED = 12

# Keys the projection owns and a record may never supply. ``_omitted_fields`` is the
# pipeline's own "here is what we withheld" channel; in wildcard mode a source could
# otherwise ship a field literally named ``_omitted_fields`` and forge the one
# provenance signal this module exists to provide. Reserved keys are dropped from
# every candidate set, so only the projection can write them.
RESERVED_KEYS: frozenset[str] = frozenset({"_omitted_fields", "_record_truncated"})

# Exact serialised overhead of one ``"key": value`` pair under ``json.dumps``
# defaults: two quotes, ``": "`` and ``", "``. Counted precisely so the accounted
# budget is a real bound rather than an approximation that drifts over by a few
# characters per field.
_PAIR_OVERHEAD = 6

# Headroom held back for the projection's own notes (``_omitted_fields`` /
# ``_record_truncated``), so reporting a withholding can never be what pushes the
# payload over its own budget. Capped at a third of a small budget so a tight budget
# still spends most of itself on actual evidence.
_OMITTED_NOTE_RESERVE = 240

# Depth bound for the wildcard walk, mirroring ``engine/sample_analysis.py``.
_MAX_WILDCARD_DEPTH = 8

# Leaf bound for the wildcard walk, before the size budget is even consulted.
_MAX_WILDCARD_LEAVES = 500


def _bound_key(path: str) -> str:
    """Length-bound one field NAME. See :data:`EVIDENCE_MAX_KEY_CHARS`."""
    return truncate(path, EVIDENCE_MAX_KEY_CHARS)


def normalise_evidence_fields(raw: Any) -> tuple[str, ...]:
    """Coerce a stored/overlaid config value into an ordered, deduped path tuple.

    Deliberately TOTAL: it never raises and never rejects. Per-source overlays land
    on ``Preferences`` through ``model_copy(update=...)``, which does NOT validate,
    so the attribute can hold anything an operator (or a malformed stored document)
    put there. Read-time coercion is what keeps a bad value from turning a prompt
    into a traceback — and ``ConfigStore.load`` resets the operator's ENTIRE config
    on any validation error, so raising here would be far worse than dropping a
    junk entry.

    ``None`` means "not configured" and yields the default set. An explicit empty
    list is an operator choosing the previous narrow behaviour, and is preserved.
    """
    if raw is None:
        return DEFAULT_EVIDENCE_FIELDS
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple, set, frozenset)):
        return DEFAULT_EVIDENCE_FIELDS
    items = [item.strip() for item in raw if isinstance(item, str)]
    # A wildcard subsumes every sibling path, so it is detected over the WHOLE input
    # before any bound applies — collapsing to the canonical form makes every
    # downstream check a single identity test, and a wildcard listed past
    # ``MAX_EVIDENCE_FIELDS`` is honoured rather than silently turning whole-record
    # mode back into an allowlist.
    wildcard = EVIDENCE_WILDCARD in items
    out: list[str] = [EVIDENCE_WILDCARD] if wildcard else []
    seen: set[str] = set(out)
    for raw_path in items:
        # Bound the PATH, not only the value it will fetch: a configured path is
        # echoed into the free-text field list, the rendered KQL and the searched-
        # fields disclosure, so an unbounded one is unbounded in three places at once.
        path = _bound_key(raw_path)
        if not path or path in seen or path in RESERVED_KEYS:
            continue
        seen.add(path)
        out.append(path)
        if len(out) >= MAX_EVIDENCE_FIELDS:
            break
    # A wildcard leads, because it subsumes every sibling for DISPLAY. The siblings
    # are still carried, though: they are how an operator names a non-ECS path, and
    # dropping them would leave that path shown (by the wildcard) but never
    # searchable (search resolves a wildcard to the curated default set) — a field
    # visible-but-unsearchable, which is half of the original bug.
    return tuple(out)


def is_wildcard(fields: Any) -> bool:
    """True when the projection ships the whole record, budget-bounded.

    Total, like :func:`normalise_evidence_fields` and for the same reason: this is
    called on values that reached ``Preferences`` through an unvalidated per-source
    overlay, so it must answer for a malformed one rather than raise inside a prompt
    build or a search.
    """
    return EVIDENCE_WILDCARD in normalise_evidence_fields(fields)


def searchable_evidence_fields(fields: Any) -> tuple[str, ...]:
    """The evidence paths free-text search may fan out over.

    Two deliberate divergences from the display projection, both spelled out here so
    they live in exactly one place:

    * Wildcard resolves to the curated default set rather than to ``"*"``: an
      unbounded ``multi_match`` across every field of a large alert index is a real
      and unpredictable query cost, and the read-only credential is shared with
      ingestion. Wildcard widens what the model SEES without widening what
      Elasticsearch MATCHES on.
    * :data:`NON_TEXT_SEARCH_FIELDS` are dropped: a substring search against a
      ``long`` or an ``ip`` is meaningless, and asking for one breaks the query.
    """
    resolved = normalise_evidence_fields(fields)
    if EVIDENCE_WILDCARD in resolved:
        named = [p for p in resolved if p != EVIDENCE_WILDCARD]
        resolved = DEFAULT_EVIDENCE_FIELDS + tuple(
            p for p in named if p not in DEFAULT_EVIDENCE_FIELDS
        )
    return tuple(p for p in resolved if p not in NON_TEXT_SEARCH_FIELDS)


def free_text_search_fields(
    *,
    rule_name_field: str,
    message_field: str,
    evidence_fields: Any,
) -> list[str]:
    """The fields a ``contains`` free-text filter is matched against.

    The four the connector has always searched, in their original order (so an
    existing deployment's result set only ever GROWS), plus the configured message
    field when it differs from the ECS literal, plus every searchable evidence
    path. Deduped, order-stable, and bounded by :data:`MAX_SEARCH_FIELDS`.

    Sharing this with the projection is the whole point: a field the model is shown
    is a field the model can then ask about. Before, ``url.path`` was in neither
    list, so an agent that suspected the gap ran ``contains:"http"``, got zero hits
    from four fields that could not have matched, and recorded that zero as
    evidence that no HTTP context existed.
    """
    ordered: list[str] = [rule_name_field, "message", "event.original", "event.action"]
    if message_field:
        ordered.append(message_field)
    ordered.extend(searchable_evidence_fields(evidence_fields))
    out: list[str] = []
    seen: set[str] = set()
    for field in ordered:
        if not isinstance(field, str):
            continue
        name = field.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
        if len(out) >= MAX_SEARCH_FIELDS:
            break
    return out


def clamp_evidence_budget(value: Any) -> int:
    """Bound a configured per-event budget into the supported range.

    Read-time clamping (rather than a Pydantic constraint alone) because this value
    also arrives through the connector's per-source ``model_copy(update=...)``
    overlay, which bypasses validation entirely.
    """
    try:
        budget = int(value)
    except (TypeError, ValueError, OverflowError):
        # OverflowError covers float('inf'); ValueError covers float('nan') and any
        # unparseable string. This function is TOTAL by contract — it is fed values
        # that reached Preferences through an unvalidated per-source overlay.
        return DEFAULT_EVIDENCE_MAX_CHARS_PER_EVENT
    if budget <= 0:
        return 0
    return min(budget, MAX_EVIDENCE_MAX_CHARS_PER_EVENT)


# --------------------------------------------------------------------------- #
# Projection
# --------------------------------------------------------------------------- #


def _is_bulky(path: str) -> bool:
    """True for a rule-DEFINITION path or anything nested beneath one.

    Prefix, not equality: the walk flattens ``kibana.alert.rule.parameters`` into
    leaves like ``kibana.alert.rule.parameters.query``, and an exact-match check
    would rank the single largest static blob on the document as ordinary evidence —
    letting it outrank the URL that decides the case.
    """
    return any(path == b or path.startswith(f"{b}.") for b in BULKY_METADATA_FIELDS)


def _is_absent(value: Any) -> bool:
    """Absent means "the record does not carry this", NOT "the value is falsy".

    ``0`` (a status code, a port, a count) and ``False`` (an outcome flag) are
    evidence and must survive; ``None``/``""``/``[]``/``{}`` are not.
    """
    return value is None or value == "" or value == [] or value == {}


def _bound_value(value: Any) -> Any:
    """Length-bound one leaf so a single huge field cannot eat the whole budget.

    Scalars pass through untouched (a truncated number would be a WRONG number);
    strings are truncated with the house ``…`` marker; structures are serialised
    then truncated, which keeps the withholding visible rather than silent.
    """
    if isinstance(value, bool) or isinstance(value, (int, float)) or value is None:
        return value
    if isinstance(value, str):
        return truncate(value, EVIDENCE_MAX_VALUE_CHARS)
    return truncate(json.dumps(value, default=str), EVIDENCE_MAX_VALUE_CHARS)


def _cost(key: str, value: Any) -> int:
    """Exact serialised cost of one ``"key": value`` pair, punctuation included."""
    return len(key) + len(json.dumps(value, default=str)) + _PAIR_OVERHEAD


def _safe_dotted_get(doc: Any, path: str) -> Any:
    """``dotted_get`` that tolerates a non-dict/None document.

    ``utils.dotted_get`` raises ``TypeError`` on ``path in doc`` when ``doc`` is
    ``None`` or a scalar. A push-source record normalised from an odd payload can
    be either, and an exception while BUILDING a prompt would drop the whole alert.
    """
    if not isinstance(doc, dict):
        return None
    try:
        return dotted_get(doc, path)
    except (TypeError, AttributeError):  # pragma: no cover — defensive
        return None


def record_carries(source: Any, path: str) -> bool:
    """True when the record actually holds a value at ``path``.

    A direct lookup, deliberately: a caller that instead intersects a BOUNDED path
    inventory reports a present field as absent the moment the record is large enough
    for the bound to bite — which is the original bug, arriving through the one
    affordance built to diagnose it.
    """
    return not _is_absent(_safe_dotted_get(source, path))


def _flatten_leaves(
    doc: Any, prefix: str = "", depth: int = 0
) -> tuple[list[tuple[str, Any]], bool]:
    """Walk a record to its leaves as ``(dotted_path, value)`` pairs.

    Returns the pairs plus whether a depth or count bound cut the walk short, so the
    caller can SAY the record was only partly read instead of presenting a partial
    walk as the whole record.

    A list is treated as a LEAF (serialised whole by ``_bound_value``) rather than
    exploded per index, so an array of 500 items stays one bounded field instead of
    500 unbounded ones.
    """
    if not isinstance(doc, dict):
        return [], False
    if depth >= _MAX_WILDCARD_DEPTH:
        # There IS more record below this point; the walk simply stopped.
        return [], bool(doc)
    out: list[tuple[str, Any]] = []
    truncated = False
    for key, value in doc.items():
        if not isinstance(key, str):
            continue
        if len(out) >= _MAX_WILDCARD_LEAVES:
            truncated = True
            break
        path = f"{prefix}{key}"
        if isinstance(value, dict) and value:
            nested, nested_truncated = _flatten_leaves(value, f"{path}.", depth + 1)
            out.extend(nested)
            truncated = truncated or nested_truncated
        else:
            out.append((path, value))
    if len(out) > _MAX_WILDCARD_LEAVES:
        truncated = True
        out = out[:_MAX_WILDCARD_LEAVES]
    return out, truncated


def _wildcard_candidates(source: Any) -> tuple[list[tuple[str, Any]], bool]:
    """Every leaf of the record, ordered so the budget drops the right things.

    Decision-relevant defaults first (in their own priority order), then everything
    else alphabetically, then the rule-DEFINITION metadata blobs last — so when the
    budget binds it withholds the rule's static description, not this alert's URL.

    The default paths are additionally read DIRECTLY rather than relied on to fall
    out of the walk. The walk is bounded in depth and leaf count and runs in document
    order, so a record that buries ``url.path`` behind 500 earlier leaves would
    otherwise lose the very field this module exists to surface — silently, which is
    the original bug in a new costume.
    """
    leaves, truncated = _flatten_leaves(source)
    by_path = {path: value for path, value in leaves}
    for path in DEFAULT_EVIDENCE_FIELDS:
        if path not in by_path:
            value = _safe_dotted_get(source, path)
            if not _is_absent(value):
                by_path[path] = value
    priority = {path: rank for rank, path in enumerate(DEFAULT_EVIDENCE_FIELDS)}

    def sort_key(item: tuple[str, Any]) -> tuple[int, int, str]:
        path = item[0]
        if _is_bulky(path):
            return (2, 0, path)
        if path in priority:
            return (0, priority[path], path)
        return (1, 0, path)

    return sorted(by_path.items(), key=sort_key), truncated


def project_evidence(
    source: Any,
    fields: Any = None,
    *,
    base: dict[str, Any],
    max_chars: int = DEFAULT_EVIDENCE_MAX_CHARS_PER_EVENT,
    already_carried: Sequence[str] = (),
) -> dict[str, Any]:
    """Project one raw record into a bounded, decision-relevant dict.

    ``base`` is the caller's pre-existing identity projection (its own key names,
    unchanged) and is ALWAYS kept — bounding evidence must never cost an event its
    id. On top of it, each configured path that the record actually carries is
    added, in configured order, while the running serialised size stays inside
    ``max_chars``.

    Absent fields are simply not rendered: a deployment whose alerts have no HTTP
    context sees exactly what it saw before, with no empty-key noise.

    What could not fit is named back under ``_omitted_fields``. That key is the
    difference between "this record has no URL" and "we did not send you its URL",
    and the whole bug this module exists for was the pipeline being unable to tell
    the model which of the two it was looking at.

    A path that collides with one of ``base``'s own keys is skipped: the identity
    keys hold the CONFIGURED field mapping's canonical value for that entity, which
    is what every other surface reports, and a second differently-derived value
    under the same name would be worse than useless to the model. ``already_carried``
    extends that to paths a caller's base holds under a DIFFERENT name (``es_query``
    carries ``event.action`` as ``action``, a wire name its result table depends on),
    so the same value is not spent twice out of one budget.

    ``_omitted_fields`` and the other :data:`RESERVED_KEYS` are the projection's own
    channel and are removed from every candidate set, so a record cannot ship a
    field of that name and forge a withholding notice (or an all-clear).

    The result is a plain dict of scalars and bounded strings. It is NOT fenced
    here — the caller passes it to ``fence_block``, which scrubs forged fence
    markers in every leaf and again over the serialised form, covering the
    attacker-controlled KEYS that wildcard mode can introduce (#9).
    """
    out: dict[str, Any] = {
        key: _bound_value(value)
        for key, value in base.items()
        if key not in RESERVED_KEYS
    }
    budget = clamp_evidence_budget(max_chars)
    if budget <= 0:
        return out

    # ``used`` is deliberately a slight OVER-estimate (the enclosing braces, plus a
    # trailing separator counted for the final pair that will not have one), so
    # ``used <= budget`` is a real guarantee about the serialised length rather than
    # an approximation that drifts over.
    used = 2 + sum(_cost(key, value) for key, value in out.items())
    resolved = normalise_evidence_fields(fields)

    candidates: Iterable[tuple[str, Any]]
    truncated = False
    if is_wildcard(resolved):
        candidates, truncated = _wildcard_candidates(source)
    else:
        candidates = ((path, _safe_dotted_get(source, path)) for path in resolved)

    # Hold back enough budget to report a withholding, so the act of saying "we cut
    # something" can never itself be what breaches the bound.
    spendable = max(0, budget - min(_OMITTED_NOTE_RESERVE, budget // 3))
    carried = set(already_carried)
    omitted: list[str] = []
    for path, raw_value in candidates:
        if path in out or path in RESERVED_KEYS or path in carried or _is_absent(raw_value):
            # Already carried by the caller's identity projection (under this name
            # or another), reserved for the projection itself, or simply not on the
            # record. None of those is a withholding.
            continue
        key = _bound_key(path)
        if key in out:
            # Two pathologically long record keys can collide once bounded. Keeping
            # the first is arbitrary but stable; overwriting would silently replace
            # one attacker-supplied field with another.
            continue
        value = _bound_value(raw_value)
        cost = _cost(key, value)
        if used + cost > spendable:
            if len(omitted) < MAX_OMITTED_REPORTED:
                omitted.append(key)
            continue
        out[key] = value
        used += cost

    if truncated:
        # The record was larger than the walk reads. Distinct from ``_omitted_fields``
        # (which names what was seen and dropped): this says fields exist that were
        # never even enumerated, so "not present here" is not "not on the record".
        cost = _cost("_record_truncated", True)
        if used + cost <= budget:
            out["_record_truncated"] = True
            used += cost
    # Trim the note to what the reserve actually holds. Naming FEWER withheld fields
    # is a smaller loss than breaching the bound the note exists to make honest.
    #
    # It is never trimmed to nothing, though: like the identity keys, the notice is
    # kept unconditionally. A ``base`` projection that alone approaches the budget
    # would otherwise starve every evidence field AND swallow the notice saying so —
    # which is the silent absence this whole module exists to prevent, reproduced
    # exactly. In that pathological case the payload overshoots its budget by one
    # short field name, and ``fence_block``'s own net remains the outer bound.
    while len(omitted) > 1 and used + _cost("_omitted_fields", omitted) > budget:
        omitted.pop()
    if omitted:
        out["_omitted_fields"] = omitted
    return out
