"""Round 14 WP-A8c: the retired procedure modules are gone, and ``playbooks`` has left
the permission vocabulary (SPEC §4.10.16, §3.7 step 3, §7.10).

Two guards:

* The final import grep. No module under ``backend/app`` imports, or names for a
  dynamic import, any of the retired procedure modules; their files are gone and they
  cannot be imported. The scan reads the real source with :mod:`ast` (so a docstring or
  comment that names a module for history is not an import) and also looks for the
  module paths in string literals (``importlib.import_module("app.playbooks")``).
* ``playbooks`` left ``RESOURCES`` and the default matrix. Nothing gates on it (no
  route dependency, no inline permission check, no chat tool grant), and every role's
  effective matrix, apart from the removed ``playbooks`` entry, is the same as it was
  while the resource was still listed: stored ``playbooks`` grants and denies keep
  their ``runbooks`` meaning in every layer.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import re
from pathlib import Path
from typing import Any, Iterator

import pytest

from app.config import RBACConfig
from app.constants import UserRole
from app.engine.runbook_model import BUILTIN_RUNBOOK_IDS, RUNBOOK_LIBRARY_DIR
from app.rbac import policy
from app.rbac.policy import (
    ALL,
    DEFAULT_MATRIX,
    LEGACY_RUNBOOK_RESOURCE,
    PRE_ROUND14_PROCEDURE_DEFAULTS,
    RESOURCES,
    effective_matrix,
    resolve_matrix,
)

BACKEND = Path(__file__).resolve().parents[1]
APP = BACKEND / "app"

#: Every module the removal deleted (SPEC §4.10.16), plus the write-capable legacy
#: runbook store, which only the deleted service used: the legacy namespaces are
#: read-only for one release and are read only through ``stores/legacy_procedures``.
REMOVED_MODULES: tuple[str, ...] = (
    "app.playbooks",
    "app.playbooks.durable",
    "app.playbooks.loader",
    "app.playbooks.manifest",
    "app.playbooks.registry",
    "app.stores.playbooks",
    "app.stores.runbooks",
    "app.engine.runbook_service",
    "app.engine.runbooks",
    "playbooks",
)

REMOVED_PATHS: tuple[str, ...] = (
    "app/playbooks",
    "playbooks",
    "app/stores/playbooks.py",
    "app/stores/runbooks.py",
    "app/engine/runbook_service.py",
    "app/engine/runbooks.py",
)

#: The plain-text reference runbooks the library replaced (``app/runbooks/*.md``).
RETIRED_REFERENCE_FILES: tuple[str, ...] = (
    "brute_force.md", "cloud_iam_compromise.md", "data_exfiltration.md",
    "ip_reputation.md", "mail_abuse.md", "malware.md", "port_scan.md",
    "vuln_scan.md", "web_attack.md",
)


def has_source(path: Path) -> bool:
    """True when ``path`` still holds something a checkout or a build could ship or
    import: the path itself as a file, or any file below it outside ``__pycache__``.

    A removal is judged by its source files, not by whether the directory is still
    there. Git deletes the tracked files but leaves the ignored ``__pycache__/`` of a
    checkout that ran the backend before the removal, and Python never loads a
    sourceless ``.pyc`` from ``__pycache__``, so such a leftover is not a module."""
    if path.is_file():
        return True
    if not path.is_dir():
        return False
    return any(f.is_file() and "__pycache__" not in f.relative_to(path).parts for f in path.rglob("*"))


def importable_code(spec: Any) -> bool:
    """True when a :func:`importlib.util.find_spec` result can import anything.

    ``None`` imports nothing. A regular module or package has an ``origin``. A spec
    without an origin is an implicit namespace portion: Python resolves one for any
    leftover directory on the path, including one that holds only an ignored
    ``__pycache__/``, and it imports something only when one of its locations still
    holds a source file."""
    if spec is None:
        return False
    if spec.origin is not None:
        return True
    return any(has_source(Path(loc)) for loc in (spec.submodule_search_locations or ()))


def _app_sources() -> Iterator[tuple[Path, str]]:
    for path in sorted(APP.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        yield path, path.read_text(encoding="utf-8")


def _module_name(path: Path) -> str:
    rel = path.relative_to(BACKEND).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _resolve_from(path: Path, node: ast.ImportFrom) -> str:
    """The absolute module an ``ImportFrom`` names (relative levels resolved against
    the importing module's package)."""
    if not node.level:
        return node.module or ""
    package = _module_name(path).split(".")
    if path.name != "__init__.py":
        package = package[:-1]
    base = package[: len(package) - (node.level - 1)] if node.level > 1 else package
    return ".".join([*base, *(node.module.split(".") if node.module else [])])


def _is_removed(module: str) -> bool:
    return any(module == gone or module.startswith(gone + ".") for gone in REMOVED_MODULES)


def _imports(path: Path, tree: ast.AST) -> Iterator[tuple[int, str]]:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name
        elif isinstance(node, ast.ImportFrom):
            module = _resolve_from(path, node)
            yield node.lineno, module
            # ``from app import playbooks`` / ``from .. import runbooks``: the imported
            # name may itself be a (removed) submodule.
            for alias in node.names:
                yield node.lineno, f"{module}.{alias.name}" if module else alias.name


# --------------------------------------------------------------------------- #
# The final import grep
# --------------------------------------------------------------------------- #
def test_the_import_resolver_sees_relative_imports() -> None:
    """The scan below would be vacuous if it could not resolve the relative imports
    the package uses everywhere; pin it on a known one."""
    path = APP / "state.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules = {module for _line, module in _imports(path, tree)}
    assert "app.stores.runbook_library" in modules or "app.engine.runbook_migration" in modules
    assert _is_removed("app.playbooks.registry") and _is_removed("playbooks")
    assert not _is_removed("app.playbooks_x") and not _is_removed("app.stores.runbook_library")


def test_no_module_under_backend_app_imports_a_retired_procedure_module() -> None:
    offenders: list[str] = []
    for path, source in _app_sources():
        tree = ast.parse(source, filename=str(path))
        for line, module in _imports(path, tree):
            if _is_removed(module):
                offenders.append(f"{path.relative_to(BACKEND)}:{line} imports {module}")
    assert not offenders, "retired procedure modules are still imported:\n  " + "\n  ".join(offenders)


_DOTTED_REMOVED = re.compile(
    r"^(?:app\.)?(?:playbooks(?:\.\w+)?|stores\.(?:playbooks|runbooks)|engine\.(?:runbooks|runbook_service))$"
)


def test_no_module_under_backend_app_names_a_retired_module_for_a_dynamic_import() -> None:
    """``importlib.import_module("app.engine.runbooks")`` or ``__import__`` with a
    string would slip past an import-statement scan. Only exact dotted module paths
    count; prose that mentions a module for history (docstrings, comments) does not."""
    offenders: list[str] = []
    for path, source in _app_sources():
        for node in ast.walk(ast.parse(source, filename=str(path))):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if _DOTTED_REMOVED.fullmatch(node.value.strip()) and "." in node.value:
                    offenders.append(f"{path.relative_to(BACKEND)}:{node.lineno} {node.value!r}")
    assert not offenders, "a retired module is named as a string:\n  " + "\n  ".join(offenders)


@pytest.mark.parametrize("module", REMOVED_MODULES)
def test_a_retired_procedure_module_cannot_be_imported(module: str) -> None:
    try:
        spec = importlib.util.find_spec(module)
    except ModuleNotFoundError:  # a parent package is gone too
        spec = None
    # A checkout that ran the backend before the removal keeps an ignored
    # ``__pycache__/`` where a removed package was, so Python may still resolve an
    # empty namespace portion there; it can import nothing.
    assert not importable_code(spec), (
        f"{module} is still importable from "
        f"{getattr(spec, 'origin', None) or list(getattr(spec, 'submodule_search_locations', None) or ())}"
    )


def test_a_leftover_bytecode_cache_is_not_a_retired_module(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The guards above judge a removal by its sources: a package directory that holds
    only an ignored ``__pycache__/`` (what ``git pull`` leaves behind on a checkout that
    ran the backend) counts as removed, and one that still holds a source file does
    not."""
    stale = tmp_path / "zz_r14_stale_pkg"
    (stale / "__pycache__").mkdir(parents=True)
    (stale / "__pycache__" / "registry.cpython-311.pyc").write_bytes(b"\x00")
    live = tmp_path / "zz_r14_live_pkg"
    (live / "sub").mkdir(parents=True)
    (live / "sub" / "loader.py").write_text("X = 1\n", encoding="utf-8")
    (live / "README.md").write_text("still here\n", encoding="utf-8")

    assert not has_source(stale)
    assert not has_source(tmp_path / "zz_r14_missing")
    assert has_source(live) and has_source(live / "README.md")

    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()
    stale_spec = importlib.util.find_spec("zz_r14_stale_pkg")
    # Python does resolve the leftover as a namespace portion, so a bare
    # ``spec is None`` check would wrongly fail here.
    assert stale_spec is not None and stale_spec.origin is None
    assert not importable_code(stale_spec)
    assert importlib.util.find_spec("zz_r14_stale_pkg.registry") is None
    assert importable_code(importlib.util.find_spec("zz_r14_live_pkg"))
    assert importable_code(importlib.util.find_spec("app.runbooks"))


def test_the_retired_files_are_gone_and_only_the_library_ships() -> None:
    for rel in REMOVED_PATHS:
        assert not has_source(BACKEND / rel), f"{rel} should have been removed (SPEC §4.10.16)"
    runbooks_dir = APP / "runbooks"
    for name in RETIRED_REFERENCE_FILES:
        assert not (runbooks_dir / name).exists(), f"app/runbooks/{name} should have been removed"
    top_level = sorted(p.name for p in runbooks_dir.iterdir() if p.name != "__pycache__")
    assert top_level == ["__init__.py", "library"]
    assert RUNBOOK_LIBRARY_DIR == runbooks_dir / "library"
    shipped = sorted(p.name for p in RUNBOOK_LIBRARY_DIR.glob("*.md"))
    assert shipped == sorted(f"{rid}.md" for rid in BUILTIN_RUNBOOK_IDS)
    assert len(shipped) == 12


# --------------------------------------------------------------------------- #
# ``playbooks`` left the vocabulary and the matrix (§3.7 step 3)
# --------------------------------------------------------------------------- #
def test_playbooks_left_the_resources_and_every_default_row() -> None:
    assert LEGACY_RUNBOOK_RESOURCE == "playbooks"
    assert "playbooks" not in RESOURCES
    assert RESOURCES["runbooks"] == ["read", "run", "manage", "publish"]
    for role, row in DEFAULT_MATRIX.items():
        assert "playbooks" not in row, role
    for role, row in effective_matrix().items():
        assert "playbooks" not in row, role
    # The owner's lockout-proof row is derived from RESOURCES, so it lost it too.
    assert effective_matrix()[UserRole.SUPER_ADMIN.value] == {res: [ALL] for res in RESOURCES}


def _dependency_calls(dependant: Any) -> Iterator[Any]:
    for dep in getattr(dependant, "dependencies", None) or ():
        if getattr(dep, "call", None) is not None:
            yield dep.call
        yield from _dependency_calls(dep)


def _closure_values(fn: Any) -> dict[str, Any]:
    """The free variables a closure captured, by name."""
    names = getattr(getattr(fn, "__code__", None), "co_freevars", ()) or ()
    cells = getattr(fn, "__closure__", None) or ()
    out: dict[str, Any] = {}
    for name, cell in zip(names, cells):
        try:
            out[name] = cell.cell_contents
        except ValueError:  # an empty cell
            continue
    return out


def test_no_http_route_gates_on_the_retired_resource() -> None:
    """Walk every mounted route's dependency tree and read the resource each
    ``require_permission`` closure captured."""
    from fastapi.routing import APIRoute

    from app.main import app

    gates: set[tuple[str, str]] = set()
    offenders: list[str] = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        for call in _dependency_calls(route.dependant):
            if getattr(call, "__qualname__", "") != "require_permission.<locals>._dep":
                continue
            captured = _closure_values(call)
            resource, action = captured.get("resource"), captured.get("action")
            gates.add((str(resource), str(action)))
            if resource == "playbooks":
                offenders.append(f"{sorted(route.methods)} {route.path} ({resource}:{action})")
    # Not vacuous: the walker reads the real gates.
    assert ("runbooks", "read") in gates and ("runbooks", "manage") in gates
    assert not offenders, "routes still gate on the retired resource:\n  " + "\n  ".join(offenders)


#: The names of the permission checks the backend calls: route dependencies
#: (``require_permission``, ``has_permission``, ``_enforce``), the policy helpers
#: (``can``, ``can_for_roles``, ``can_object``), the chat tool context gate
#: (``ctx.has``) and the caller-scoped view gate (``view.allows``). Any of them with a
#: ``"playbooks"`` argument, positional or keyword, is a gate on the retired resource.
_PERMISSION_CALLS = frozenset({
    "require_permission", "has_permission", "_enforce", "can", "can_for_roles", "can_object",
    "has", "allows",
})
_RETIRED_ACTIONS = frozenset({"read", "run", "manage", ALL})


def _retired_gates(source: str, rel: str) -> list[str]:
    """Every gate on the retired resource in one module's source: a permission call
    (by name, with ``"playbooks"`` anywhere in its arguments), any call whose first two
    positional arguments are ``"playbooks"`` and a retired action (a gate under a name
    this list does not know yet), a ``("playbooks", <action>)`` grant pair (chat tool
    ``requires``, ``kind_permissions``, ``optional_grants``, lookup grant tables) and a
    ``"playbooks:<action>"`` literal."""
    offenders: list[str] = []
    for node in ast.walk(ast.parse(source, filename=rel)):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            args = [*node.args, *(kw.value for kw in node.keywords)]
            named_gate = name in _PERMISSION_CALLS and any(
                isinstance(arg, ast.Constant) and arg.value == "playbooks" for arg in args
            )
            first, second = (node.args + [None, None])[:2]
            pair_gate = (
                isinstance(first, ast.Constant) and first.value == "playbooks"
                and isinstance(second, ast.Constant) and second.value in _RETIRED_ACTIONS
            )
            if named_gate or pair_gate:
                offenders.append(f"{rel}:{node.lineno} {name or 'call'}(... 'playbooks' ...)")
        elif isinstance(node, ast.Tuple) and len(node.elts) == 2:
            first, second = node.elts
            if (isinstance(first, ast.Constant) and first.value == "playbooks"
                    and isinstance(second, ast.Constant) and second.value in _RETIRED_ACTIONS):
                offenders.append(f"{rel}:{node.lineno} grant pair ('playbooks', {second.value!r})")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if re.fullmatch(r"playbooks:(?:read|run|manage|\*)", node.value):
                offenders.append(f"{rel}:{node.lineno} {node.value!r}")
    return offenders


def test_the_backend_gate_scan_recognises_every_gate_form() -> None:
    """Not vacuous: each form a backend gate takes is reported on the retired
    resource, and the same forms on a live resource are not."""
    samples = {
        "require_permission": 'Depends(require_permission("playbooks", "run"))',
        "keyword argument": 'require_permission(resource="playbooks", action="run")',
        "has_permission": 'await has_permission(request, "playbooks", "read")',
        "policy can": 'policy.can(role, "playbooks", "run", matrix=m)',
        "can_for_roles": 'can_for_roles(roles, "playbooks", "manage")',
        "chat tool context": 'ctx.has("playbooks", "read")',
        "view gate": 'view.allows("playbooks", "run")',
        "unknown gate name": 'session.permitted("playbooks", "manage")',
        "grant pair": 'requires = (("playbooks", "read"),)',
        "grant table": 'GRANTS = {"lookup": ("playbooks", "run")}',
        "literal": 'NEEDED = "playbooks:manage"',
    }
    for label, sample in samples.items():
        assert _retired_gates(sample, label), label
        assert not _retired_gates(sample.replace("playbooks", "runbooks"), label), label
    # A call that names the retired word for another reason is not a gate.
    assert not _retired_gates('legacy.read("playbooks", "README.md")', "namespace read")
    assert not _retired_gates('log.info("playbooks", extra=x)', "log")


def test_no_inline_check_or_chat_tool_grant_names_the_retired_resource() -> None:
    """Source half: no permission call with a ``"playbooks"`` argument, no
    ``("playbooks", <action>)`` grant pair or call, no ``"playbooks:<action>"``
    literal. Runtime half: every grant the chat tool catalogue declares is a live
    resource."""
    offenders: list[str] = []
    for path, source in _app_sources():
        offenders.extend(_retired_gates(source, str(path.relative_to(BACKEND))))
    assert not offenders, "the retired resource is still a gate:\n  " + "\n  ".join(offenders)

    from app.agents.chat_tools.registry import catalogue, catalogue_grant_pairs

    assert catalogue(), "the chat tool catalogue is empty; the runtime half would be vacuous"
    for resource, action in catalogue_grant_pairs():
        assert resource in RESOURCES and action in RESOURCES[resource], (resource, action)
    for tool in catalogue():
        for resource, action in getattr(tool, "kind_permissions", {}).values():
            assert resource in RESOURCES and action in RESOURCES[resource], (tool.name, resource, action)


#: The Console's permission gates: the ``<Can resource=...>`` guard, the
#: ``<ProtectedRoute resource=...>`` page guard, the ``useCan`` hook and the
#: ``hasPermission`` / ``can`` helpers, and every ``{ resource, action }`` object
#: (registry ``perm``, action and widget permission tables).
_CONSOLE_GATE = re.compile(
    r"""(?:<(?:Can|ProtectedRoute)\b[^>]*\bresource=\{?\s*["'`]playbooks["'`]"""
    r"""|\b(?:hasPermission|useCan|can)\(\s*["'`]playbooks["'`]"""
    r"""|\bresource:\s*["'`]playbooks["'`])"""
)


def test_no_console_gate_names_the_retired_resource() -> None:
    """The Console half of §3.7 step 3: no page, menu item or registry entry is gated
    on ``playbooks`` (it would never pass now that the server lists no such resource).
    The Roles matrix editor's resource mirror is a list, not a gate, and is checked by
    ``test_round14_contracts``."""
    webui = BACKEND.parent / "webui" / "src"
    sources = [
        p for p in sorted(webui.rglob("*.ts*"))
        if "__tests__" not in p.parts and not p.name.endswith((".test.ts", ".test.tsx", ".gen.ts"))
    ]
    assert len(sources) > 100, "the Console sources were not found; the scan would be vacuous"
    offenders = [
        f"{path.relative_to(BACKEND.parent)}:{source.count(chr(10), 0, match.start()) + 1}"
        for path in sources
        for source in [path.read_text(encoding="utf-8")]
        for match in _CONSOLE_GATE.finditer(source)
    ]
    # Not vacuous: the pattern recognises each gate form, and not the same form on a
    # live resource.
    for sample in (
        '<Can resource="playbooks" action="run">',
        "<Can resource={'playbooks'} action='read'>",
        '<ProtectedRoute resource="playbooks" action="read">',
        "hasPermission('playbooks', 'run')",
        "useCan('playbooks', 'run')",
        "can(`playbooks`, 'manage')",
        "perm: { resource: 'playbooks', action: 'read' }",
        "{ resource: 'playbooks', action: 'run' }",
    ):
        assert _CONSOLE_GATE.search(sample), sample
        assert not _CONSOLE_GATE.search(sample.replace("playbooks", "runbooks")), sample
    # The retired route id and the access copy that names the alias are not gates.
    for sample in ("id: 'playbooks',", "'playbooks:run': 'run runbooks',", "playbooks: ['read'],"):
        assert not _CONSOLE_GATE.search(sample), sample
    assert not offenders, "Console gates still name the retired resource:\n  " + "\n  ".join(offenders)


# --------------------------------------------------------------------------- #
# Every effective grant is unchanged apart from the removed entry (§3.7, A8c)
# --------------------------------------------------------------------------- #
T1, T2 = UserRole.ANALYST_TIER1.value, UserRole.ANALYST_TIER2.value
MGR, RESP, AUD = UserRole.SOC_MANAGER.value, UserRole.RESPONDER.value, UserRole.AUDITOR.value


def _persisted(**layers: Any) -> dict[str, Any]:
    """An ``rbac`` block as a build from before Round 14 stored it: every persisted
    key, no ``rbac_grants_version`` (the legacy load path)."""
    block: dict[str, Any] = {
        "enabled": True, "default_role": T1, "roles": {}, "custom_roles": [],
        "resources": {}, "denies": {},
    }
    block.update(layers)
    return block


#: One configuration per grant and deny layer, in both vocabularies.
LAYER_CASES: dict[str, dict[str, Any]] = {
    "defaults": {},
    "roles override names only the alias": {"roles": {T1: {"playbooks": ["read", "run"]}}},
    "roles override names both": {"roles": {T2: {"playbooks": ["read", "run"], "runbooks": ["read"]}}},
    "roles override narrows runbooks": {"roles": {RESP: {"runbooks": ["read"]}}},
    "resources layer grants the alias": {"resources": {AUD: {"playbooks": ["manage"]}}},
    "deny of the alias run": {"denies": {RESP: {"playbooks": ["run"]}}},
    "deny of the alias manage": {"denies": {MGR: {"playbooks": ["manage"]}}},
    "deny of the alias wildcard": {"denies": {T2: {"playbooks": [ALL]}}},
    "custom roles in the alias": {"custom_roles": [
        {"name": "hunter", "inherits": [T2], "grants": {"playbooks": ["manage"]}, "denies": {}},
        {"name": "no_runner", "inherits": [RESP], "grants": {}, "denies": {"playbooks": ["run"]}},
        {"name": "reader", "inherits": [], "grants": {"playbooks": ["read"], "cases": ["read"]}, "denies": {}},
    ]},
}


def _matrix(config: dict[str, Any], *, persisted: bool) -> dict[str, dict[str, list[str]]]:
    if persisted:
        return resolve_matrix(RBACConfig.model_validate(_persisted(**config)))
    return effective_matrix(
        config.get("roles"), config.get("custom_roles"),
        resources=config.get("resources"), denies=config.get("denies"),
    )


def _without_retired(matrix: dict[str, dict[str, list[str]]]) -> dict[str, dict[str, list[str]]]:
    return {
        role: {res: sorted(acts) for res, acts in row.items() if res != "playbooks"}
        for role, row in matrix.items()
    }


@pytest.mark.parametrize("persisted", [False, True], ids=["current", "stored-before-round14"])
@pytest.mark.parametrize("case", sorted(LAYER_CASES))
def test_every_effective_grant_is_unchanged_apart_from_the_retired_entry(
    case: str, persisted: bool, monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = LAYER_CASES[case]
    after = _matrix(config, persisted=persisted)
    assert all("playbooks" not in row for row in after.values())

    # The vocabulary and matrix as they were before §3.7 step 3: ``playbooks`` listed
    # with its actions and each built-in role's frozen pre-Round 14 grant of it.
    monkeypatch.setitem(policy.RESOURCES, "playbooks", ["read", "run", "manage"])
    for role, frozen in PRE_ROUND14_PROCEDURE_DEFAULTS.items():
        monkeypatch.setitem(DEFAULT_MATRIX[role], "playbooks", list(frozen["playbooks"]))
    before = _matrix(config, persisted=persisted)
    assert "playbooks" in before[T2]  # the simulation really listed the resource

    assert _without_retired(after) == _without_retired(before)


def test_the_retired_resource_still_maps_in_every_layer_after_it_left() -> None:
    """Spot checks of the meaning that survives: the alias grants and denies reach
    ``runbooks`` while ``playbooks`` itself grants nothing."""
    matrix = effective_matrix(
        {T1: {"playbooks": ["read", "run"]}},
        [{"name": "c", "inherits": [], "grants": {"playbooks": ["manage"]}, "denies": {}}],
        resources={AUD: {"playbooks": ["manage"]}},
        denies={RESP: {"playbooks": ["run"]}, MGR: {"playbooks": ["manage"]}},
    )
    assert set(matrix[T1]["runbooks"]) == {"read", "run"}
    assert set(matrix["c"]["runbooks"]) == {"manage", "publish"}
    assert {"manage", "publish"} <= set(matrix[AUD]["runbooks"])
    assert "run" not in matrix[RESP]["runbooks"] and "read" in matrix[RESP]["runbooks"]
    assert {"manage", "publish"}.isdisjoint(matrix[MGR]["runbooks"])
    assert set(matrix[MGR]["runbooks"]) == {"read", "run"}
    assert policy.can(T1, "runbooks", "run", matrix=matrix)
    assert not policy.can(T1, "playbooks", "run", matrix=matrix)


def test_a_permission_question_about_the_alias_reads_its_runbooks_meaning() -> None:
    """A spot check that names the retired resource (``GET /api/roles/simulate``, an
    API script) is answered for the access the alias really grants, never a silent
    "denied" for a resource the server no longer lists."""
    assert policy.resolve_runbook_alias("playbooks", "read") == ("runbooks", "read")
    assert policy.resolve_runbook_alias("playbooks", "run") == ("runbooks", "run")
    assert policy.resolve_runbook_alias("playbooks", "manage") == ("runbooks", "manage")
    assert policy.resolve_runbook_alias("playbooks", ALL) == ("runbooks", ALL)
    # An action the alias never had stays unknown, so it is denied on ``runbooks``.
    assert policy.resolve_runbook_alias("playbooks", "approve") == ("runbooks", "approve")
    for pair in (("runbooks", "publish"), ("cases", "read"), ("audit", "export")):
        assert policy.resolve_runbook_alias(*pair) == pair
    matrix = effective_matrix()
    for role in (T1, T2, RESP, AUD, MGR):
        for action in ("read", "run", "manage"):
            assert policy.can(role, *policy.resolve_runbook_alias("playbooks", action), matrix=matrix) == (
                policy.can(role, "runbooks", action, matrix=matrix)
            ), (role, action)
    assert policy.can(T2, *policy.resolve_runbook_alias("playbooks", "run"), matrix=matrix)
    assert not policy.can(AUD, *policy.resolve_runbook_alias("playbooks", "run"), matrix=matrix)
    assert not policy.can(T2, *policy.resolve_runbook_alias("playbooks", "approve"), matrix=matrix)


def test_the_role_simulator_answers_the_alias_for_its_runbooks_meaning() -> None:
    """``GET /api/roles/simulate`` with the retired resource reports the access the
    alias really grants (the Console's role tools may still offer it), and says which
    resource it evaluated; a current resource reports no alias."""
    from contextlib import asynccontextmanager

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes_roles import router as roles_router
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.llm.providers import MockProvider
    from app.state import AppState

    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(
            secrets=Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                            anthropic_api_key=None, openai_api_key=None),
            es=InMemoryESClient(),
            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock},
        )
        await state.startup(start_poller=False)
        api.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(roles_router)
    with TestClient(api) as client:
        def simulate(role: str, resource: str, action: str) -> dict[str, Any]:
            res = client.get("/api/roles/simulate", params={"role": role, "resource": resource, "action": action})
            assert res.status_code == 200, res.text
            return res.json()

        for role in (T1, T2, RESP, AUD, MGR, UserRole.SUPER_ADMIN.value):
            for action in ("read", "run", "manage"):
                alias, current = simulate(role, "playbooks", action), simulate(role, "runbooks", action)
                assert alias["allowed"] is current["allowed"], (role, action)
                assert alias["actions"] == current["actions"], (role, action)
                assert alias["known_resource"] is True and alias["alias_of"] == "runbooks"
                assert alias["resource"] == "playbooks" and alias["action"] == action
                assert current["alias_of"] is None
        assert simulate(T2, "playbooks", "run")["allowed"] is True
        assert simulate(AUD, "playbooks", "run")["allowed"] is False
        assert simulate(T2, "cases", "close")["alias_of"] is None


def test_a_stale_alias_key_beside_a_narrowed_runbooks_entry_grants_nothing() -> None:
    """A map stored in Round 14 keeps the ``playbooks`` key a legacy load carried
    (verbatim, so a rollback reads the grant it stored). With the resource gone it is
    inert: the narrowed ``runbooks`` entry is the whole answer."""
    cfg = RBACConfig(enabled=True, roles={T2: {"playbooks": ["read", "run", "manage"], "runbooks": ["read"]}})
    assert cfg.roles[T2]["playbooks"] == ["read", "run", "manage"]
    row = resolve_matrix(cfg)[T2]
    assert row["runbooks"] == ["read"]
    assert "playbooks" not in row
