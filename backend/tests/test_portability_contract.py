"""Portability contract — nothing SHIPPED may hardcode one deployer's environment.

This suite is open source and is installed by many organisations. Anything that is
shaped by a particular environment — rule names, index names, field names, a SIEM
vendor, a threshold tuned to one data set — must be CONFIG or DERIVED, never baked
into shipped source or shipped content.

SCOPE, stated honestly: this is a source lint over the **backend source tree** and
the **bundled Markdown playbooks in ``backend/playbooks/``**. It does not inspect
the Web Console, the deploy manifests, `docs/`, or anything an operator authors at
runtime — operator-authored playbooks in a ``Preferences.playbooks.dir`` override
are *expected* to name that site's own detections and are deliberately out of scope.

It asserts **SHAPE, never vocabulary.** There is no blocklist of one operator's
proper nouns here, on purpose: such a list goes stale the moment that operator
renames something, and it would render a different verdict in a deployment that has
never heard of those systems. A shape assertion, by contrast, is meaningful
everywhere and stays true for any future catalog.

Distribution/packaging is a different contract and lives in
``tests/test_distribution_contract.py`` (it builds a wheel and runs a subprocess).
Keep this file fast and import-light.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from app.config import default_rule_catalog
from app.playbooks.loader import load_playbooks

BACKEND_ROOT = Path(__file__).resolve().parents[1]
BUNDLED_PLAYBOOK_DIR = BACKEND_ROOT / "playbooks"
METRICS_MODULE = BACKEND_ROOT / "app" / "engine" / "metrics.py"

# ONE portable-identifier grammar, and it really is one: lowercase ASCII words joined
# by a single ``_`` or ``-`` separator.
#
# It rejects every shape a copied SIEM rule TITLE has — spaces, capitals, ``:``,
# ``|``, ``/``, parentheses — in ANY deployment, without naming a single product.
# ``-`` is accepted as an equivalent separator because the shipped SAMPLE rule
# catalog contains ``waf-nginx-access`` (see ``config._SAMPLE_EVENT_MODULES``): a
# hyphen is a perfectly portable slug character, and forcing a rename there would
# desynchronise the sample rule from the ``event.module`` literal it demonstrates.
#
# ONE grammar is not a convenience, it is a correctness requirement. A playbook's
# ``match.rule_ids`` and a ``RuleDefinition.name`` are the SAME namespace —
# ``models.RawEvent.from_hit`` sets ``rule = matched.name`` and
# ``playbooks.registry.select_playbook`` intersects ``rule_ids`` against exactly that
# value. Applying a stricter pattern to one end than the other would make this file
# contradict itself: it would certify ``waf-nginx-access`` as a portable seeded rule
# name while rejecting the bundled playbook that binds to it, and the failure message
# would then demand a rename the shipped catalog has already fixed.
PORTABLE_ID = re.compile(r"^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$")

# An ATT&CK technique id: ``T1110``, or a sub-technique ``T1550.001``. Techniques are a
# PUBLIC vocabulary, so a bundled playbook may name them verbatim — but only in that
# shape. Anything else in ``match.mitre`` is some deployment's local vocabulary
# wearing a MITRE field's name.
MITRE_TECHNIQUE_ID = re.compile(r"^T\d{4}(?:\.\d{3})?$")

# A dotted, lowercase document path: ``event.module``, ``rule.id``, ``user.name``.
# A single leading ``@`` is allowed because ``@timestamp`` is a standard ECS field.
DOTTED_LOWER_PATH = re.compile(r"^@?[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$")

# Absolute date literals: an ISO or slashed calendar date, or a ``datetime``/``date``
# constructor opening with a literal 4-digit year.
ABSOLUTE_DATE = re.compile(
    r"\d{4}-\d{2}-\d{2}"
    r"|\d{4}/\d{2}/\d{2}"
    r"|\b(?:datetime|date)\(\s*(?:19|20)\d{2}\s*,"
)

_TEACH_RULE_IDS = (
    "A bundled playbook's rule-name criteria are PORTABLE LAYER-3 IDENTIFIERS, not a "
    "deployer's SIEM rule titles. `select_playbook` compares them against the "
    "cluster's rule set, so a title pasted from one SIEM ('Some Product: Thing "
    "(Detail) ES|QL') can only ever match in the single deployment it came from; "
    "every other installation of this open-source suite gets a playbook that never "
    "fires. Declare a portable lowercase slug id here (e.g. `external_admin_panel_"
    "access`) and let the OPERATOR's rule catalog map their own title onto it with "
    "a RuleDefinition (name=<portable id>, match: field=rule.name op=equals "
    "value=<their exact title>). See backend/playbooks/README.md.\n\n"
    "This covers `match.rule_ids` AND the two soft criteria `match.any_tags` and "
    "`match.mitre`: registry.select_playbook matches all three against the SAME "
    "cluster rule set, and a playbook whose ONLY criteria are the soft ones is "
    "selectable *only* when a rule name hits them — so a SIEM title parked in "
    "`any_tags` is deployment-locked in exactly the way this lint exists to stop."
)


def _bundled_playbooks():
    """Load the bundled set through the PRODUCTION parser.

    Using ``load_playbooks`` is deliberate: it is the same code the registry runs,
    so the lint reads exactly what the app reads. It also means BOTH supported
    front-matter shapes are covered — ``rule_ids`` nested under ``match:`` and
    ``rule_ids`` declared flat at column 0 (flat wins on collision) — because the
    loader merges them before we see them. This test lints the VALUES; it does not
    care which nesting a playbook chose.
    """
    playbooks = load_playbooks(BUNDLED_PLAYBOOK_DIR)
    # The loader SKIPS an unparseable file with a warning. Without this guard a
    # playbook that stopped parsing would silently drop out of the lint.
    on_disk = sorted(
        p.name
        for p in BUNDLED_PLAYBOOK_DIR.glob("*.md")
        if p.stem.lower() not in {"readme", "index"}
    )
    assert len(playbooks) == len(on_disk), (
        f"{len(on_disk)} bundled playbook file(s) on disk but only {len(playbooks)} "
        f"parsed: {on_disk}. A skipped file is invisible to this lint — fix the "
        f"front matter before relying on the assertions below."
    )
    assert playbooks, "no bundled playbooks found; the lint would be vacuous"
    return playbooks


def test_bundled_playbook_rule_name_criteria_are_portable_identifiers() -> None:
    """Every bundled criterion matched against the cluster RULE SET is portable.

    Scoped by what ``registry.select_playbook`` actually compares, not by field name.
    It intersects ``match.rule_ids`` with the cluster rule set and ALSO tests
    ``match.mitre`` and ``match.any_tags`` against the same (lowercased) set — and a
    playbook declaring only those soft criteria is selectable *solely* on such a hit.
    Linting one field of the three would let a copied SIEM title in ``any_tags``
    deployment-lock a playbook while this file reported clean, which is the class of
    defect the lint exists to prevent rather than one instance of it.

    ``mitre`` gets the technique grammar instead: ATT&CK ids are a public vocabulary
    and are portable BECAUSE they are standard, so ``T1550.001`` must pass while a
    local rule title in the same field must not.
    """
    offenders: list[str] = []
    seen = 0
    for playbook in _bundled_playbooks():
        name = Path(playbook.source_path).name
        match = playbook.manifest.match
        for field, values, pattern in (
            ("rule_ids", match.rule_ids, PORTABLE_ID),
            ("any_tags", match.any_tags, PORTABLE_ID),
            ("mitre", match.mitre, MITRE_TECHNIQUE_ID),
        ):
            for value in values or []:
                seen += 1
                if pattern.fullmatch(str(value)) is None:
                    offenders.append(f"{name}: match.{field} {value!r} (want {pattern.pattern})")

    assert seen, "no bundled playbook declares any rule-name criteria; the lint would be vacuous"
    assert not offenders, (
        "Non-portable rule-name criterion/criteria in bundled playbook front matter:\n  "
        + "\n  ".join(offenders)
        + "\n\n"
        + _TEACH_RULE_IDS
    )


def test_seeded_default_rule_catalog_is_shape_portable() -> None:
    """The seeded SAMPLE catalog uses portable rule names and dotted field paths.

    A shape assertion on GENERATED output (rather than on a frozen list of names)
    stays true for any future catalog, and keeps holding after an operator or a
    later round edits ``default_rule_catalog``.
    """
    catalog = default_rule_catalog()
    assert catalog, "default_rule_catalog() is empty; the lint would be vacuous"

    bad_names = [rd.name for rd in catalog if PORTABLE_ID.fullmatch(rd.name) is None]
    assert not bad_names, (
        f"Seeded rule name(s) are not portable identifiers: {bad_names}\n"
        f"Required shape: {PORTABLE_ID.pattern}\n"
        "A rule NAME is the Layer-3 identifier that playbooks, precedent and the "
        "threshold tuner key on. Keep it a lowercase slug and put the "
        "environment-specific literal in `match.value` instead."
    )

    bad_fields = [
        f"{rd.name}: {rd.match.field!r}"
        for rd in catalog
        if DOTTED_LOWER_PATH.fullmatch(rd.match.field or "") is None
    ]
    assert not bad_fields, (
        "Seeded rule match field(s) are not dotted lowercase document paths:\n  "
        + "\n  ".join(bad_fields)
        + f"\nRequired shape: {DOTTED_LOWER_PATH.pattern}\n"
        "`match.field` addresses a path inside a normalised record, resolved with "
        "`utils.dotted_get`. A capitalised alias, a bracketed/indexed expression, "
        "or backend-specific quoting is a spelling that will not resolve on every "
        "deployment. (Note the shape check cannot see semantics: `rule.id.keyword` "
        "IS dotted lowercase yet never exists in an Elasticsearch `_source` — that "
        "class of bug is covered by audit #16's heal in `maybe_seed_rule_catalog`.)"
    )


def test_metrics_module_has_no_absolute_date_literal() -> None:
    """`engine/metrics.py` must never pin a calendar date.

    A TRIPWIRE, deliberately scoped to this ONE file. Reporting windows here are
    always derived from ``now`` and operator configuration; the failure mode this
    guards is a future outage/backfill window being excluded by a hardcoded date,
    which silently produces a different number in every other deployment.

    Repo-wide is the wrong scope: several provider and release modules carry API
    version pins that are date-shaped by design and must not be flagged —
    ``anthropic-version: 2023-06-01`` (``llm/providers.py``, ``llm/batch.py``),
    ``X-GitHub-Api-Version: 2022-11-28`` (``engine/release_discovery.py``), and the
    Azure ``api_version`` default.
    """
    source = METRICS_MODULE.read_text(encoding="utf-8")
    hits = [
        f"line {i}: {line.strip()}"
        for i, line in enumerate(source.splitlines(), start=1)
        if ABSOLUTE_DATE.search(line)
    ]
    assert not hits, (
        f"Absolute date literal(s) in {METRICS_MODULE.name}:\n  "
        + "\n  ".join(hits)
        + "\n\nDerive every boundary from `now` plus operator configuration. If an "
        "outage or backfill window genuinely has to be excluded, that window is "
        "CONFIG (a Preferences field an operator sets for their own environment), "
        "never a literal compiled into shipped source."
    )


# --------------------------------------------------------------------------- #
# The precedent TEXT-REPAIR selector must stay derive-and-compare.
# --------------------------------------------------------------------------- #
RAG_MODULE = BACKEND_ROOT / "app" / "tools" / "rag.py"

# The functions that make up the explicit precedent text-repair pass. Named rather
# than pattern-matched so a rename has to come here and be thought about.
REPAIR_FUNCTIONS = (
    "repair_precedent_projection",
    "precedent_text_staleness",
    "_classify_precedent_text",
    "_reprojected_precedent_item",
    "_current_precedent_text",
    "_tally_precedent_findings",
)

# Ways of asking "does this text contain that". None of them belongs in a selector
# whose only legitimate question is "does the current builder render exactly this".
TEXT_SEARCH_METHODS = frozenset(
    {
        "startswith",
        "endswith",
        "find",
        "rfind",
        "index",
        "rindex",
        "count",
        "lower",
        "upper",
        "casefold",
        "search",
        "match",
        "fullmatch",
        "findall",
        "finditer",
        "sub",
        "split",
    }
)

# A SQL wildcard predicate, in the one shape that can appear in shipped source.
SQL_LIKE = re.compile(r"\bLIKE\b")

# The length above which a spaced string literal is PROSE rather than a key or a
# separator. Below it, a substring test against rendered precedent produces noise
# ("at" is inside "Analyst"), which is why the derived check below applies only to
# literals that are long enough to be a template fragment.
PROSE_LITERAL_MIN_CHARS = 8

_TEACH_REPAIR_SELECTOR = (
    "The precedent repair selector is DERIVE-AND-COMPARE: render the case again "
    "through the same projector the projection uses, and compare the two strings. It "
    "cannot be a prose match, and that is not a style preference.\n\n"
    "`_unconfirmed_case_text` renders the model's verdict sentence UNCONDITIONALLY for "
    "every lower-trust chunk, while `test_precedent_corpus.py` asserts that exact "
    "phrase never appears in the confirmed tier. One phrase, two opposite meanings — "
    "so a substring selector on it deletes a whole trust tier, and only on the "
    "deployments that enabled that tier. Confirmed-tier text additionally carries the "
    "analyst note, the model's recommended action and log-derived evidence summaries, "
    "so any selector over chunk text is a selector over attacker- and "
    "operator-influenceable content (#9).\n\n"
    "SHAPE, never vocabulary: there is no blocklist here. The prose check below is "
    "DERIVED from what the product's own builders render today, so it stays true for "
    "any future template."
)


def _repair_function_nodes() -> dict[str, ast.AST]:
    """Every repair function's AST, located by name in the real module source."""
    tree = ast.parse(RAG_MODULE.read_text(encoding="utf-8"))
    found: dict[str, ast.AST] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in REPAIR_FUNCTIONS:
                found[node.name] = node
    missing = sorted(set(REPAIR_FUNCTIONS) - set(found))
    assert not missing, (
        f"the repair lint cannot find {missing} in {RAG_MODULE.name}; a rename must "
        "update REPAIR_FUNCTIONS or this lint silently checks nothing"
    )
    return found


def _string_constants(node: ast.AST) -> list[str]:
    """Every string literal in a function EXCEPT its docstring."""
    docstring = ast.get_docstring(node, clean=False) if isinstance(
        node, (ast.FunctionDef, ast.AsyncFunctionDef)
    ) else None
    out: list[str] = []
    for child in ast.walk(node):
        if isinstance(child, ast.Constant) and isinstance(child.value, str):
            if docstring is not None and child.value == docstring:
                continue
            out.append(child.value)
    return out


def test_the_precedent_repair_selector_is_not_a_text_match() -> None:
    """No containment test, no string-search call, no regex, no SQL wildcard."""
    offences: list[str] = []
    for name, node in sorted(_repair_function_nodes().items()):
        for child in ast.walk(node):
            if isinstance(child, ast.Compare):
                operands = [child.left, *child.comparators]
                literal = any(
                    isinstance(op, ast.Constant) and isinstance(op.value, str)
                    for op in operands
                )
                if literal and any(
                    isinstance(op, (ast.In, ast.NotIn)) for op in child.ops
                ):
                    offences.append(f"{name}: substring/containment test on a literal")
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute):
                if child.func.attr in TEXT_SEARCH_METHODS:
                    offences.append(f"{name}: text-search call .{child.func.attr}()")
            if isinstance(child, ast.Name) and child.id == "re":
                offences.append(f"{name}: regular-expression matching")
        for literal in _string_constants(node):
            if SQL_LIKE.search(literal):
                offences.append(f"{name}: SQL LIKE predicate in {literal!r}")

    assert not offences, (
        "Precedent repair uses a text match:\n  "
        + "\n  ".join(sorted(set(offences)))
        + "\n\n"
        + _TEACH_REPAIR_SELECTOR
    )


def test_the_precedent_repair_carries_no_projection_template_prose() -> None:
    """No literal in the repair is a fragment of what the projectors render.

    DERIVED, not enumerated: both tiers are rendered here from a synthetic case and
    the repair's own literals are checked against those renderings. A future template
    change moves the reference automatically, and a deployment that has never heard of
    this vocabulary gets the same verdict.
    """
    renderings = " \n ".join(_rendered_precedent_tiers()).lower()
    offences: list[str] = []
    for name, node in sorted(_repair_function_nodes().items()):
        for literal in _string_constants(node):
            candidate = literal.strip()
            if len(candidate) < PROSE_LITERAL_MIN_CHARS or " " not in candidate:
                continue
            if candidate.lower() in renderings:
                offences.append(f"{name}: {literal!r}")

    assert not offences, (
        "A repair literal reproduces projection template prose:\n  "
        + "\n  ".join(sorted(set(offences)))
        + "\n\n"
        + _TEACH_REPAIR_SELECTOR
    )


def test_the_repair_derives_through_the_shared_projectors() -> None:
    """The positive half: the repair must CALL the projectors, not re-implement them.

    A second renderer would drift from the projection it is supposed to converge on,
    and the drift would be invisible for exactly the same reason the original defect
    was — nothing records which generation produced a chunk's text.
    """
    nodes = _repair_function_nodes()
    called = {
        child.func.attr
        for node in nodes.values()
        for child in ast.walk(node)
        if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute)
    }
    for projector in ("_resolved_case_item", "_unconfirmed_case_item"):
        assert projector in called, (
            f"the repair does not call {projector}; re-rendering must go through the "
            "SAME projector the projection uses or the two will disagree"
        )
    assert "_is_unconfirmed" in called, (
        "tier must be resolved through the EXISTING retrieval predicate; a second "
        "tier test can disagree with how retrieval actually treats the chunk"
    )


def _rendered_precedent_tiers() -> tuple[str, str]:
    """What each precedent tier renders TODAY, for one synthetic case."""
    from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
    from app.models import Case, Entity, EvidenceItem
    from app.tools.rag import RagService

    case = Case(
        case_id="case-lint",
        cluster_signature="sig:lint",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.1"),
        rule_ids=["portable_rule_id"],
        verdict=Verdict.FALSE_POSITIVE,
        confidence=0.5,
        risk_score=1.0,
        status=CaseStatus.CLOSED,
        decision_by=DecisionBy.AGENT,
        evidence=[EvidenceItem(summary="synthetic")],
        recommended_action="none",
    )
    return (
        RagService._resolved_case_text(case, "false_positive", "synthetic"),
        RagService._unconfirmed_case_text(case, "false_positive"),
    )
